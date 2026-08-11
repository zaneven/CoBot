import { InlineKeyboard, type Api, type Context } from "grammy";
import type { Store, ApprovalMode } from "../store/db.js";
import type { PermissionRequest, PermissionDecision } from "../claude/types.js";
import type { SilenceIndicator } from "./indicator.js";
import { logger } from "../util/logger.js";

/** Per-task context the bot layer passes to each approval request. */
export interface ApprovalCtx {
  api: Api;
  chatId: number;
  indicator: SilenceIndicator;
  mode: ApprovalMode;
  skipTools: Set<string>;
  timeoutMs: number;
  /** What to do when the user doesn't respond in time. Default "allow". */
  timeoutAction: "allow" | "deny";
}

type Action = "allow" | "deny" | "always";

interface Pending {
  requestId: string;
  shortId: number;
  chatId: number;
  toolName: string;
  resolve: (dec: PermissionDecision) => void;
  promise: Promise<PermissionDecision>;
  timer: ReturnType<typeof setTimeout> | undefined;
  messageId: number | undefined;
  done: boolean;
}

const DECIDED_CAP = 1000;

/**
 * Interactive tool-approval bridge. The driver's `canUseTool` delegates here;
 * the bot's `callbackQuery(/^appr:/)` resolves pending requests. The manager is
 * a process-wide singleton (one pending map across all chats) — the SDK calls
 * `canUseTool` serially per task, so there's normally one pending request at a
 * time, but the map supports several.
 *
 * Design notes:
 * - Never resolves a request with `null` (that blocks the tool forever in the
 *   SDK). Timeout / abort / send-failure all fall back to a concrete decision.
 * - Idempotent per `requestId`: the SDK may redeliver a request after a
 *   reconnect; a cached decision is returned and a duplicate pending is deduped.
 * - `callback_data` is `appr:<shortId>:<action>` (shortId is a small int) to
 *   stay well under Telegram's 64-byte limit even with long SDK request ids.
 */
export class ApprovalManager {
  private store?: Store;
  private pending = new Map<string, Pending>();
  private decided = new Map<string, PermissionDecision>();
  private shortToRequest = new Map<number, string>();
  private nextShort = 1;

  init(store: Store): void {
    this.store = store;
  }

  /** Decide + (maybe) prompt. Never returns null; idempotent per requestId. */
  request(req: PermissionRequest, ctx: ApprovalCtx, signal: AbortSignal): Promise<PermissionDecision> {
    const cached = this.decided.get(req.requestId);
    if (cached) return Promise.resolve(cached);
    const existing = this.pending.get(req.requestId);
    if (existing) return existing.promise;

    // Policy short-circuits — no prompt, no message:
    // - mode auto → allow everything (headless behaviour)
    // - read-only / skipTools → allow
    // - a long-term "always allow" rule for this chat+tool → allow
    if (ctx.mode === "auto") return Promise.resolve(this.record(req.requestId, { behavior: "allow" }));
    if (ctx.skipTools.has(req.toolName)) return Promise.resolve(this.record(req.requestId, { behavior: "allow" }));
    if (this.store?.isAlwaysAllowed(ctx.chatId, req.toolName)) {
      return Promise.resolve(this.record(req.requestId, { behavior: "allow" }));
    }

    return this.prompt(req, ctx, signal);
  }

  /** Resolve a pending request from a Telegram inline-button tap. */
  async handleCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? "";
    const m = data.match(/^appr:(\d+):(allow|deny|always)$/);
    if (!m) {
      await ctx.answerCallbackQuery();
      return;
    }
    const shortId = Number(m[1]);
    const action = m[2] as Action;
    const chatId = ctx.chat?.id;
    const requestId = this.shortToRequest.get(shortId);

    if (!requestId || !chatId) {
      await ctx.answerCallbackQuery({ text: "审批已过期" });
      return;
    }
    const p = this.pending.get(requestId);
    if (!p) {
      await ctx.answerCallbackQuery({ text: "审批已过期" });
      return;
    }
    if (p.chatId !== chatId) {
      await ctx.answerCallbackQuery({ text: "该审批不属于当前会话" });
      return;
    }

    let dec: PermissionDecision;
    let note: string;
    if (action === "allow") {
      dec = { behavior: "allow" };
      note = "已允许";
    } else if (action === "deny") {
      dec = { behavior: "deny", message: "用户拒绝" };
      note = "已拒绝";
    } else {
      this.store?.addAlwaysAllow(chatId, p.toolName);
      dec = { behavior: "allow" };
      note = "始终允许";
    }
    this.settle(p, dec, ctx.api, note);
    await ctx.answerCallbackQuery({ text: note });
  }

  /** Deny any still-pending requests for a chat (task end / abort safety net). */
  cancelForChat(chatId: number, api?: Api): void {
    for (const p of [...this.pending.values()]) {
      if (p.chatId === chatId) this.settle(p, { behavior: "deny", message: "任务结束" }, api, "⏹ 任务结束");
    }
  }

  // ---- internals ----

  private prompt(req: PermissionRequest, ctx: ApprovalCtx, signal: AbortSignal): Promise<PermissionDecision> {
    const shortId = this.nextShort++;
    this.shortToRequest.set(shortId, req.requestId);

    const title = req.title || req.displayName || req.toolName;
    const summary = summarizeInput(req);
    const text = `🔐 审批请求\n${title}${summary ? `\n\n${summary}` : ""}`;
    const cb = (a: Action) => `appr:${shortId}:${a}`;
    const keyboard = new InlineKeyboard()
      .text("✅ 允许", cb("allow"))
      .text("❌ 拒绝", cb("deny"))
      .row()
      .text("⭐ 始终允许", cb("always"));

    let resolveRef!: (dec: PermissionDecision) => void;
    const promise = new Promise<PermissionDecision>((r) => {
      resolveRef = r;
    });
    const pending: Pending = {
      requestId: req.requestId,
      shortId,
      chatId: ctx.chatId,
      toolName: req.toolName,
      resolve: resolveRef,
      promise,
      timer: undefined,
      messageId: undefined,
      done: false,
    };
    this.pending.set(req.requestId, pending);

    // Send the prompt without blocking the return; the promise resolves via
    // settle() on user tap / timeout / abort. If the send itself fails, fall
    // back to allow so the task isn't blocked by a messaging problem.
    void (async () => {
      try {
        const m = await ctx.api.sendMessage(ctx.chatId, text, { reply_markup: keyboard });
        if (!pending.done) {
          pending.messageId = (m as { message_id?: number }).message_id;
          ctx.indicator.activity();
        } else if ((m as { message_id?: number }).message_id !== undefined) {
          // Settled before the message landed — clean up the orphan.
          ctx.api.deleteMessage(ctx.chatId, (m as { message_id: number }).message_id).catch(() => undefined);
        }
      } catch (err) {
        logger.warn({ err: String(err) }, "approval message send failed; auto-allowing");
        this.settle(pending, { behavior: "allow" }, ctx.api, "发送失败 → 自动允许");
      }
    })();

    // Timeout → timeoutAction (default allow: convenient for a personal bot,
    // i.e. "approve when present, auto-run when away"). Configurable to "deny".
    pending.timer = setTimeout(() => {
      if (pending.done) return;
      const dec: PermissionDecision =
        ctx.timeoutAction === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "审批超时" };
      this.settle(pending, dec, ctx.api, ctx.timeoutAction === "allow" ? "⏱ 超时 → 自动允许" : "⏱ 超时 → 拒绝");
    }, ctx.timeoutMs);

    // Abort (e.g. /stop or the task watchdog) → deny so the SDK can be interrupted.
    if (signal) {
      if (signal.aborted) {
        this.settle(pending, { behavior: "deny", message: "已中止" }, ctx.api, "⏹ 已中止");
      } else {
        signal.addEventListener(
          "abort",
          () => this.settle(pending, { behavior: "deny", message: "已中止" }, ctx.api, "⏹ 已中止"),
          { once: true },
        );
      }
    }

    return promise;
  }

  private settle(p: Pending, dec: PermissionDecision, api: Api | undefined, note: string): void {
    if (p.done) return;
    p.done = true;
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = undefined;
    }
    this.pending.delete(p.requestId);
    this.shortToRequest.delete(p.shortId);
    this.record(p.requestId, dec);
    p.resolve(dec);
    if (api && p.messageId !== undefined) {
      const mark = dec.behavior === "allow" ? "✅ 已允许" : "❌ 已拒绝";
      api.editMessageText(p.chatId, p.messageId, `🔐 ${mark} · ${p.toolName} (${note})`).catch(() => undefined);
    }
  }

  private record(requestId: string, dec: PermissionDecision): PermissionDecision {
    if (this.decided.size >= DECIDED_CAP) this.decided.clear();
    this.decided.set(requestId, dec);
    return dec;
  }
}

/** One-line summary of the tool input (command / path / url …) for the prompt. */
function summarizeInput(req: PermissionRequest): string {
  const o = req.input;
  if (o && typeof o === "object") {
    for (const k of ["command", "file_path", "path", "pattern", "url", "query"]) {
      const v = (o as Record<string, unknown>)[k];
      if (typeof v === "string") return truncate(v, 200);
    }
  }
  return "";
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Process-wide singleton. `init(store)` is called once at startup. */
export const approvalManager = new ApprovalManager();
