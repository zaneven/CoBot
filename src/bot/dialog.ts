import { InlineKeyboard, type Api, type Context } from "grammy";
import type { SilenceIndicator } from "./indicator.js";
import type { UserDialogRequest, UserDialogResult } from "../claude/types.js";
import { logger } from "../util/logger.js";

/** Per-task context the bot layer passes to each dialog request. */
export interface DialogCtx {
  api: Api;
  chatId: number;
  indicator: SilenceIndicator;
  /** Max wait for an answer (ms). Clamped to ≤ the SDK's park deadline so our
   *  own timeout always fires first — otherwise the SDK gives up and our
   *  promise would never resolve, hanging the worker. */
  timeoutMs: number;
}

interface QOption {
  label: string;
  description?: string;
}
interface QItem {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QOption[];
}
interface Pending {
  requestId: string;
  shortId: number;
  chatId: number;
  questions: QItem[];
  /** selections[qIdx] = selected option indices (≥1 when answered). */
  selections: number[][];
  resolve: (res: UserDialogResult) => void;
  promise: Promise<UserDialogResult>;
  timer: ReturnType<typeof setTimeout> | undefined;
  messageId: number | undefined;
  done: boolean;
}

/** Hard cap so our own timeout always fires before the SDK's 5-min park
 *  deadline (CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS default). If we let the SDK
 *  give up first, our promise would never resolve and the worker would hang. */
const MAX_DIALOG_TIMEOUT_MS = 240_000;
/** Lower bound so a misconfigured tiny timeout still gives the user a moment. */
const MIN_DIALOG_TIMEOUT_MS = 30_000;
const DECIDED_CAP = 1000;

/**
 * User-dialog bridge (AskUserQuestion). The driver's `onUserDialog` delegates
 * here; the bot's `callbackQuery(/^ask:/)` resolves pending dialogs, and a
 * plain-text reply resolves a freeform ("Other") answer.
 *
 * Design mirrors {@link ApprovalManager}:
 * - Never resolves with a dangling promise: timeout / abort / send-failure /
 *   unknown-kind all settle to a concrete {@link UserDialogResult} so the SDK
 *   never parks the dialog (which would hang the worker).
 * - Idempotent per `requestId`: the SDK may redeliver a dialog after a
 *   reconnect; a cached result is returned and a duplicate pending is deduped.
 * - `callback_data` is `ask:<shortId>:<qIdx>:<optIdx>` for option taps and
 *   `ask:<shortId>:<submit|other|cancel>` for actions. `shortId` is a small int
 *   (not the long SDK request id) to stay well under Telegram's 64-byte limit.
 *
 * Gating: only wired for interactive tasks (origin !== "cron"). Cron runs leave
 * the driver's `userDialogHandler` unset so AskUserQuestion degrades to the
 * SDK's no-dialog default — safe for headless.
 */
export class DialogManager {
  private pending = new Map<string, Pending>();
  private decided = new Map<string, UserDialogResult>();
  private shortToRequest = new Map<number, string>();
  /** chatId → requestId armed to capture the next plain-text freeform reply. */
  private textCapture = new Map<number, string>();
  private nextShort = 1;

  /** Render a dialog and wait for the user's answer. Never returns a dangling
   *  promise; idempotent per requestId. Unknown dialogKinds → cancelled. */
  ask(req: UserDialogRequest, ctx: DialogCtx, signal: AbortSignal): Promise<UserDialogResult> {
    const cached = this.decided.get(req.requestId);
    if (cached) return Promise.resolve(cached);
    const existing = this.pending.get(req.requestId);
    if (existing) return existing.promise;

    // Only AskUserQuestion is supported. Unknown / unrenderable kinds → cancel
    // so the model proceeds with its default (per the SDK contract).
    if (req.dialogKind !== "ask_user_question") {
      return Promise.resolve(this.record(req.requestId, { behavior: "cancelled" }));
    }
    const questions = parseQuestions(req.payload);
    if (!questions) {
      logger.warn({ dialogKind: req.dialogKind, requestId: req.requestId }, "user dialog payload unparseable; cancelling");
      return Promise.resolve(this.record(req.requestId, { behavior: "cancelled" }));
    }

    return this.prompt(req.requestId, questions, ctx, signal);
  }

  /** Resolve an option/action tap from a Telegram inline button. */
  async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const parts = data.split(":");
    // ask:<shortId>:<action>  OR  ask:<shortId>:<qIdx>:<optIdx>
    if (parts.length < 3 || parts[0] !== "ask") {
      await ctx.answerCallbackQuery();
      return;
    }
    const shortId = Number(parts[1]);
    const requestId = this.shortToRequest.get(shortId);
    const chatId = ctx.chat?.id;
    if (!requestId || !chatId) {
      await ctx.answerCallbackQuery({ text: "问题已过期" });
      return;
    }
    const p = this.pending.get(requestId);
    if (!p || p.chatId !== chatId) {
      await ctx.answerCallbackQuery({ text: p ? "该问题不属于当前会话" : "问题已过期" });
      return;
    }

    // Action button: ask:<shortId>:<submit|other|cancel>
    if (parts.length === 3) {
      const action = parts[2];
      if (action === "cancel") {
        this.settle(p, { behavior: "cancelled" }, ctx.api, "✖️ 已取消");
        await ctx.answerCallbackQuery({ text: "已取消" });
        return;
      }
      if (action === "other") {
        // Arm freeform capture: the next plain-text message becomes the reply.
        this.textCapture.set(chatId, requestId);
        await ctx.answerCallbackQuery({ text: "请直接发送文字回复" });
        return;
      }
      if (action === "submit") {
        const missing = p.questions.findIndex((_, qIdx) => (p.selections[qIdx]?.length ?? 0) === 0);
        if (missing >= 0) {
          await ctx.answerCallbackQuery({ text: `还有问题未作答（第 ${missing + 1} 题）` });
          return;
        }
        const res = this.buildResult(p);
        this.settle(p, res, ctx.api, "✅ 已提交");
        await ctx.answerCallbackQuery({ text: "已提交" });
        return;
      }
      await ctx.answerCallbackQuery();
      return;
    }

    // Option button: ask:<shortId>:<qIdx>:<optIdx>
    if (parts.length === 4) {
      const qIdx = Number(parts[2]);
      const optIdx = Number(parts[3]);
      const q = p.questions[qIdx];
      if (!q || !Number.isInteger(qIdx) || !Number.isInteger(optIdx) || optIdx < 0 || optIdx >= q.options.length) {
        await ctx.answerCallbackQuery({ text: "无效选项" });
        return;
      }
      const opt = q.options[optIdx];
      if (!opt) {
        await ctx.answerCallbackQuery({ text: "无效选项" });
        return;
      }

      // Single question, single-select: one tap immediately resolves (the
      // common case — mirrors the one-tap feel of tool approval).
      if (p.questions.length === 1 && !q.multiSelect) {
        const res: UserDialogResult = {
          behavior: "completed",
          result: {
            questions: echoQuestions(p.questions),
            answers: { [q.question]: opt.label },
          },
        };
        this.settle(p, res, ctx.api, `✅ ${opt.label}`);
        await ctx.answerCallbackQuery({ text: `已选：${opt.label}` });
        return;
      }

      // Multi-question or multi-select: accumulate then submit.
      if (q.multiSelect) {
        const sel = p.selections[qIdx] ?? (p.selections[qIdx] = []);
        const at = sel.indexOf(optIdx);
        if (at >= 0) sel.splice(at, 1);
        else sel.push(optIdx);
        sel.sort((a, b) => a - b);
      } else {
        p.selections[qIdx] = [optIdx];
      }
      this.rerender(p, ctx.api);
      const selected = (p.selections[qIdx]?.length ?? 0) > 0;
      await ctx.answerCallbackQuery({ text: `${selected ? "✓ " : ""}${opt.label}` });
      return;
    }

    await ctx.answerCallbackQuery();
  }

  /** Capture a freeform ("Other") reply: if a dialog for this chat is armed,
   *  the next plain-text message becomes the `response` field. Returns true
   *  when the text was consumed (so handleText can skip normal prompt routing). */
  async handleTextReply(chatId: number, text: string, api: Api): Promise<boolean> {
    const requestId = this.textCapture.get(chatId);
    if (!requestId) return false;
    const p = this.pending.get(requestId);
    if (!p || p.chatId !== chatId) {
      this.textCapture.delete(chatId);
      return false;
    }
    const res: UserDialogResult = {
      behavior: "completed",
      result: {
        questions: echoQuestions(p.questions),
        answers: {},
        response: text,
      },
    };
    this.settle(p, res, api, "✍️ 已回复");
    return true;
  }

  /** Cancel any still-pending dialogs for a chat (task end / abort safety net). */
  cancelForChat(chatId: number, api?: Api): void {
    for (const p of [...this.pending.values()]) {
      if (p.chatId === chatId) this.settle(p, { behavior: "cancelled" }, api, "⏹ 任务结束");
    }
    this.textCapture.delete(chatId);
  }

  // ---- internals ----

  private prompt(
    requestId: string,
    questions: QItem[],
    ctx: DialogCtx,
    signal: AbortSignal,
  ): Promise<UserDialogResult> {
    const shortId = this.nextShort++;
    this.shortToRequest.set(shortId, requestId);

    let resolveRef!: (res: UserDialogResult) => void;
    const promise = new Promise<UserDialogResult>((r) => {
      resolveRef = r;
    });
    const pending: Pending = {
      requestId,
      shortId,
      chatId: ctx.chatId,
      questions,
      selections: questions.map(() => []),
      resolve: resolveRef,
      promise,
      timer: undefined,
      messageId: undefined,
      done: false,
    };
    this.pending.set(requestId, pending);

    const text = renderDialogText(questions);
    const keyboard = buildKeyboard(pending);

    // Non-blocking send (mirrors ApprovalManager): we return `promise` and let
    // the message land in the background. If the send itself fails we cancel so
    // the task isn't left waiting on a question the user will never see.
    void (async () => {
      try {
        const m = await ctx.api.sendMessage(ctx.chatId, text, { reply_markup: keyboard, link_preview_options: { is_disabled: true } });
        if (!pending.done) {
          pending.messageId = (m as { message_id?: number }).message_id;
          ctx.indicator.activity();
        } else if ((m as { message_id?: number }).message_id !== undefined) {
          // Settled before the message landed — clean up the orphan.
          ctx.api.deleteMessage(ctx.chatId, (m as { message_id: number }).message_id).catch(() => undefined);
        }
      } catch (err) {
        logger.warn({ err: String(err) }, "dialog message send failed; cancelling");
        this.settle(pending, { behavior: "cancelled" }, ctx.api, "发送失败 → 取消");
      }
    })();

    const timeoutMs = Math.min(Math.max(ctx.timeoutMs, MIN_DIALOG_TIMEOUT_MS), MAX_DIALOG_TIMEOUT_MS);
    pending.timer = setTimeout(() => {
      if (pending.done) return;
      this.settle(pending, { behavior: "cancelled" }, ctx.api, "⏱ 超时已取消");
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        this.settle(pending, { behavior: "cancelled" }, ctx.api, "⏹ 已中止");
      } else {
        signal.addEventListener(
          "abort",
          () => this.settle(pending, { behavior: "cancelled" }, ctx.api, "⏹ 已中止"),
          { once: true },
        );
      }
    }

    return promise;
  }

  /** Refresh the inline keyboard to reflect ✓ marks after a selection change. */
  private rerender(p: Pending, api: Api): void {
    if (p.done || p.messageId === undefined) return;
    const keyboard = buildKeyboard(p);
    api.editMessageReplyMarkup(p.chatId, p.messageId, { reply_markup: keyboard }).catch(() => undefined);
  }

  /** Build a structured (non-freeform) result from the accumulated selections. */
  private buildResult(p: Pending): UserDialogResult {
    const answers: Record<string, string> = {};
    p.questions.forEach((q, qIdx) => {
      const sel = p.selections[qIdx] ?? [];
      if (sel.length > 0) {
        const labels: string[] = [];
        for (const oi of sel) {
          const lbl = q.options[oi]?.label;
          if (lbl) labels.push(lbl);
        }
        if (labels.length) answers[q.question] = labels.join(", ");
      }
    });
    return { behavior: "completed", result: { questions: echoQuestions(p.questions), answers } };
  }

  /** Idempotent: clear timer + maps, record the decision, resolve the promise,
   *  and edit the message to show the outcome. No-op if already settled. */
  private settle(p: Pending, res: UserDialogResult, api: Api | undefined, note: string): void {
    if (p.done) return;
    p.done = true;
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = undefined;
    }
    this.pending.delete(p.requestId);
    this.shortToRequest.delete(p.shortId);
    // Clear any text-capture arming pointing at this dialog.
    if (this.textCapture.get(p.chatId) === p.requestId) this.textCapture.delete(p.chatId);
    this.record(p.requestId, res);
    p.resolve(res);
    if (api && p.messageId !== undefined) {
      api
        .editMessageText(p.chatId, p.messageId, `${renderDialogText(p.questions)}\n\n— ${note}`, {
          link_preview_options: { is_disabled: true },
        })
        .catch(() => undefined);
    }
  }

  /** Record a decision for idempotent redelivery; bounded LRU-ish (clear on cap). */
  private record(requestId: string, res: UserDialogResult): UserDialogResult {
    if (this.decided.size >= DECIDED_CAP) this.decided.clear();
    this.decided.set(requestId, res);
    return res;
  }
}

/** Shared singleton — wired from runs.ts and bot.ts. */
export const dialogManager = new DialogManager();

// ---- pure helpers (no `this`) ----

/** Defensively parse an AskUserQuestion payload into renderable questions.
 *  Returns null if the shape is wrong (→ the dialog is cancelled, not crashed). */
function parseQuestions(payload: Record<string, unknown>): QItem[] | null {
  const qs = payload.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return null;
  const out: QItem[] = [];
  for (const q of qs) {
    if (!q || typeof q !== "object") return null;
    const o = q as Record<string, unknown>;
    const question = typeof o.question === "string" ? o.question : "";
    const header = typeof o.header === "string" ? o.header : "";
    const multiSelect = o.multiSelect === true;
    const optsRaw = o.options;
    if (!Array.isArray(optsRaw) || optsRaw.length < 2 || optsRaw.length > 4) return null;
    const options: QOption[] = [];
    for (const op of optsRaw) {
      if (!op || typeof op !== "object") return null;
      const oo = op as Record<string, unknown>;
      const label = typeof oo.label === "string" ? oo.label : "";
      if (!label) return null;
      const description = typeof oo.description === "string" ? oo.description : undefined;
      options.push({ label, description });
    }
    out.push({ question, header, multiSelect, options });
  }
  return out;
}

/** Echo the questions back as the `questions` field of AskUserQuestionOutput,
 *  which the SDK/tool expects to be present alongside `answers`. */
function echoQuestions(qs: QItem[]): unknown[] {
  return qs.map((q) => ({
    question: q.question,
    header: q.header,
    multiSelect: q.multiSelect,
    options: q.options.map((o) => ({ label: o.label, description: o.description ?? "" })),
  }));
}

/** Render the dialog body (questions) + a mode-appropriate hint. */
function renderDialogText(qs: QItem[]): string {
  const body = qs
    .map((q, i) => {
      const tag = q.header ? `[${q.header}] ` : "";
      const num = qs.length > 1 ? `${i + 1}. ` : "";
      return `❓ ${num}${tag}${q.question}`;
    })
    .join("\n\n");
  const oneTap = qs.length === 1 && !qs[0]!.multiSelect;
  const hint = oneTap
    ? "（点选一项作答；或点「其他」直接发送文字回复）"
    : "（点选后按「✅ 提交」作答；或点「其他」直接发送文字回复）";
  return `${body}\n\n${hint}`;
}

/** Build the inline keyboard for a pending dialog. */
function buildKeyboard(p: Pending): InlineKeyboard {
  const kb = new InlineKeyboard();
  const singleQSingleSelect = p.questions.length === 1 && !p.questions[0]!.multiSelect;
  const multi = p.questions.length > 1;
  p.questions.forEach((q, qIdx) => {
    q.options.forEach((opt, optIdx) => {
      const selected = (p.selections[qIdx] ?? []).includes(optIdx);
      const mark = selected ? "✓ " : "";
      const prefix = multi ? `${q.header || `Q${qIdx + 1}`}: ` : "";
      const budget = 64 - mark.length - prefix.length - 1;
      kb.text(mark + prefix + truncateTo(opt.label, Math.max(budget, 8)), `ask:${p.shortId}:${qIdx}:${optIdx}`);
    });
    kb.row();
  });
  // Submit only when accumulation is needed (multi-question or multi-select);
  // single-question single-select resolves on the first option tap.
  if (!singleQSingleSelect) {
    kb.text("✅ 提交", `ask:${p.shortId}:submit`).row();
  }
  kb.text("✍️ 其他", `ask:${p.shortId}:other`);
  kb.text("✖️ 取消", `ask:${p.shortId}:cancel`);
  return kb;
}

/** Truncate to n chars with an ellipsis; never returns more than n chars. */
function truncateTo(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(n - 1, 0))}…` : s;
}
