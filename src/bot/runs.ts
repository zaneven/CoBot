import type { Api } from "grammy";
import { type Config, DEFAULT_APPROVAL_SKIP_TOOLS } from "../config.js";
import type { Store, AuditLog } from "../store/db.js";
import type { Registry } from "../registry/registry.js";
import type { PromptInput, PermissionRequest, PermissionDecision } from "../claude/types.js";
import { runClaude } from "../claude/driver.js";
import { TelegramStreamer } from "./streaming.js";
import { SilenceIndicator } from "./indicator.js";
import { sendRichText } from "../util/send.js";
import { logger } from "../util/logger.js";
import { approvalManager } from "./approval.js";
import { buildNextActions, renderSuggestionKeyboard, extractNextActions, NextActionsStreamFilter, NEXT_ACTIONS_DIRECTIVE } from "./nextActions.js";

export interface RunOutcome {
  status: "done" | "aborted" | "error";
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextUsagePct?: number;
  tools: string[];
}

/**
 * Run one Claude Code turn: stream the assistant output into the chat and
 * persist the result. Does NOT touch the registry's active/queue state - the
 * caller (runOne) owns start/finish + draining.
 */
async function runTurn(opts: {
  api: Api;
  chatId: number;
  projectPath: string;
  sessionId: string | null;
  prompt: PromptInput;
  config: Config;
  registry: Registry;
  store: Store;
  origin: "interactive" | "cron";
  abortSignal: AbortSignal;
  onSessionId?: (id: string) => void;
}): Promise<RunOutcome> {
  const { api, chatId, projectPath, sessionId, prompt, config, registry, store, origin, abortSignal, onSessionId } = opts;

  const indicator = new SilenceIndicator(api, chatId);
  indicator.start();

  // Interactive tool approval: only for interactive tasks (cron runs
  // unattended → auto-approve) and only when the chat's mode is "interactive".
  // Otherwise the driver falls back to headless auto-approve.
  const approvalCfg = config.claude.approval;
  const chatMode = store.getBinding(chatId)?.approvalMode ?? approvalCfg?.mode ?? "auto";
  const installApproval = chatMode === "interactive" && origin !== "cron" && !!approvalCfg;
  const canUseToolHandler = installApproval && approvalCfg
    ? (req: PermissionRequest, sig: AbortSignal): Promise<PermissionDecision> =>
        approvalManager.request(req, {
          api,
          chatId,
          indicator,
          mode: chatMode,
          skipTools: new Set(approvalCfg.skipTools),
          timeoutMs: approvalCfg.timeoutMs,
          timeoutAction: approvalCfg.timeoutAction,
        }, sig)
    : undefined;

  // Telegram's "typing…" indicator expires after ~5 s; refresh a little sooner.
  // Fire once immediately then every 4.5 s. Non-critical — errors are swallowed.
  const typingTimer = setInterval(() => api.sendChatAction(chatId, "typing").catch(() => undefined), 4500);
  typingTimer.ref();   // keep the process alive while the task runs
  api.sendChatAction(chatId, "typing").catch(() => undefined);

  logger.info({ chatId, project: projectPath, resume: sessionId ?? null }, "starting claude task");

  let hadError = false;
  let driverAborted = false;
  let abortedReason: "timeout" | "user" | undefined;
  let capturedSessionId: string | undefined;
  const toolsUsed: string[] = [];
  let capturedCostUsd: number | undefined;
  let capturedDurationMs: number | undefined;
  let capturedInputTokens: number | undefined;
  let capturedOutputTokens: number | undefined;
  let capturedContextUsagePct: number | undefined;

  // ── Multi-message structure (Claude-Code-style) ──────────────────────────
  // ① Each agentic "round" becomes its own Telegram message: a header line
  //   (how long it thought + what tools it called) above THAT ROUND'S OWN text
  //   output, streamed live. Each round shows only its own slice — nothing is
  //   accumulated across rounds, so the per-round views stay short.
  // ② We *used* to also send the final round's text as a separate "clean
  //   answer" message. But ① already streams that exact text live, so doing so
  //   just duplicated the content. Now ② is only emitted when its text differs
  //   from the last ① message (see shouldSendFinalAnswer), keeping the final
  //   answer visible without showing it twice.
  // ③ Then a done summary (token counts, cost, duration).
  let currentRound: TelegramStreamer | null = null;
  let roundStartMs = 0;
  let roundToolCounts: Record<string, number> = {};
  let roundText = ""; // this round's own answer text (reset each round)
  let lastRoundText = ""; // the final round's text, used for ②

  // Streaming filter: hides a trailing <next-actions> block (if the model
  // emitted one) from the live ① message so it never shows in chat — we turn
  // that block into buttons instead.
  const nextFilter = new NextActionsStreamFilter();

  /** Build the current round's top-of-message header. `durationMs` omitted while
   *  the round is still streaming (shows "思考中"); pass it at finalize. */
  function roundHeader(durationMs?: number): string {
    const bits: string[] = [`⏱️ 思考 ${durationMs !== undefined ? fmtDuration(durationMs) : "中"}`];
    const toolS = fmtToolSummary(roundToolCounts);
    if (toolS) bits.push(toolS);
    return bits.join(" · ");
  }

  try {
    for await (const ev of runClaude({
      prompt,
      cwd: projectPath,
      resume: sessionId ?? undefined,
      model: config.claude.model,
      permissionMode: config.claude.permissionMode,
      allowedTools: config.claude.allowedTools,
      allowDangerouslySkipPermissions:
        config.claude.permissionMode === "bypassPermissions" && config.claude.allowDangerousSkip,
      maxTurns: config.claude.maxTurns,
      signal: abortSignal,
      timeoutMs: config.claude.taskTimeoutMs,
      canUseToolHandler,
    })) {
      switch (ev.kind) {
        case "init":
          if (!sessionId) {
            capturedSessionId = ev.sessionId;
            onSessionId?.(ev.sessionId);
          }
          break;
        case "roundStart":
          // Close the previous round's message (its text was already streamed
          // live into the body) and open a fresh one for this round.
          if (currentRound) {
            currentRound.setHeader(roundHeader(Date.now() - roundStartMs));
            await currentRound.finalize();
          }
          currentRound = new TelegramStreamer(api, chatId, config.telegram.maxEditChars, config.telegram.flushMs);
          roundStartMs = Date.now();
          roundToolCounts = {};
          roundText = "";
          currentRound.setHeader(roundHeader());
          break;
        case "text":
          indicator.activity();
          // Stream this round's own text into ①, but suppress any trailing
          // <next-actions> block the model emitted — we render that as buttons
          // instead of showing it inline.
          const disp = nextFilter.feed(ev.delta);
          roundText += disp;
          if (currentRound && disp) await currentRound.text(disp);
          break;
        case "thinking":
          // Reasoning in progress — show a progress marker so a long think
          // isn't silent, but don't surface the (very long) chain-of-thought in
          // chat; the answer text is what lands in ①.
          indicator.thinking();
          break;
        case "tool":
          indicator.activity();
          if (!toolsUsed.includes(ev.name)) toolsUsed.push(ev.name);
          roundToolCounts[ev.name] = (roundToolCounts[ev.name] ?? 0) + 1;
          // Live-update the round header with the running tool count.
          if (currentRound) currentRound.setHeader(roundHeader());
          if (config.telegram.showToolCalls && currentRound) {
            await currentRound.toolLine(ev.name, ev.summary);
          }
          break;
        case "toolResult":
          indicator.activity();
          if (config.telegram.showToolCalls && currentRound) await currentRound.toolResult(ev.name, ev.content, ev.isError);
          break;
        case "status":
          if (ev.status === "compacting") indicator.compacting();
          else indicator.activity();
          break;
        case "done":
          capturedCostUsd = ev.costUsd;
          capturedDurationMs = ev.durationMs;
          capturedInputTokens = ev.usage?.inputTokens;
          capturedOutputTokens = ev.usage?.outputTokens;
          capturedContextUsagePct = ev.contextUsagePct;
          // Flush any text the filter held back (the tail it kept to avoid
          // leaking a partial <next-actions> tag), then close the final round's
          // message. Capture its text as the answer.
          const tail = nextFilter.finish();
          if (tail.trailing) {
            roundText += tail.trailing;
            if (currentRound) await currentRound.text(tail.trailing);
          }
          if (currentRound) {
            currentRound.setHeader(roundHeader(Date.now() - roundStartMs));
            lastRoundText = roundText.trim();
            await currentRound.finalize();
            currentRound = null;
          }
          if (ev.contextUsagePct !== undefined) {
            registry.setContextUsage(chatId, ev.contextUsagePct);
          }
          if (ev.aborted) {
            driverAborted = true;
            if (ev.abortedReason) abortedReason = ev.abortedReason;
          }
          if (ev.isError) {
            hadError = true;
            logger.error({ text: ev.text, costUsd: ev.costUsd, durationMs: ev.durationMs }, "claude task finished with error");
            const detail = ev.text ? `\n\`\`\`\n${ev.text.slice(0, 1000)}\n\`\`\`` : "";
            await sendRichText(api, chatId, `⚠️ Finished with error.${detail}`);
          } else if (ev.aborted) {
            const reason =
              abortedReason === "timeout" ? ` (timed out after ${Math.round(config.claude.taskTimeoutMs / 60000)}m)` : "";
            await api.sendMessage(chatId, `⏹ Interrupted${reason}.`);
          } else {
            // ② Final answer as its own clean message (no per-round header).
            //    Only send it when it differs from the last ① message — ①
            //    already streams the final round's text live, so a matching ②
            //    would just repeat the same content.
            const answer = lastRoundText || extractNextActions(ev.text).cleaned.trim();
            if (shouldSendFinalAnswer(answer, roundText)) {
              const answerStreamer = new TelegramStreamer(api, chatId, config.telegram.maxEditChars, config.telegram.flushMs);
              await answerStreamer.text(answer);
              await answerStreamer.finalize();
            }
            // ③ Done summary (original format: token counts included).
            const parts: string[] = ["✅ Done"];
            if (ev.usage) parts.push(`↑${fmtTokens(ev.usage.inputTokens)} ↓${fmtTokens(ev.usage.outputTokens)}`);
            if (ev.contextUsagePct !== undefined) parts.push(`📊 ${ev.contextUsagePct}%`);
            if (ev.costUsd) parts.push(`$${ev.costUsd.toFixed(4)}`);
            if (ev.durationMs) parts.push(`${(ev.durationMs / 1000).toFixed(1)}s`);
            await api.sendMessage(chatId, parts.join(" · "));
            // ④ Suggested next actions — quick buttons under the result. Prefers
            //    the model's own <next-actions> block (semantic, accurate); falls
            //    back to heuristic inference. Wrapped so a hiccup can never break
            //    the final message already delivered above.
            try {
              const suggestions = buildNextActions(ev.text);
              if (suggestions.length) {
                await api.sendMessage(chatId, "💡 建议的下一步操作：", {
                  reply_markup: renderSuggestionKeyboard(suggestions, chatId),
                });
              }
            } catch (err) {
              logger.debug({ err: String(err) }, "next-action suggestions failed");
            }
          }
          break;
        case "error":
          hadError = true;
          if (currentRound) {
            await currentRound.finalize();
            currentRound = null;
          }
          await sendRichText(api, chatId, `❌ ${ev.message}`);
          break;
      }
    }
  } catch (err) {
    hadError = true;
    logger.error({ err: String(err) }, "runTurn error");
    if (currentRound) {
      await currentRound.finalize();
      currentRound = null;
    }
    await sendRichText(api, chatId, `❌ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearInterval(typingTimer);
    await indicator.stop();
    // Safety net: deny any approval prompt still open for this chat (e.g. the
    // task aborted while waiting on a tap).
    approvalManager.cancelForChat(chatId, api);
  }

  return {
    status: hadError ? "error" : (driverAborted || abortSignal.aborted) ? "aborted" : "done",
    sessionId: capturedSessionId,
    costUsd: capturedCostUsd,
    durationMs: capturedDurationMs,
    inputTokens: capturedInputTokens,
    outputTokens: capturedOutputTokens,
    contextUsagePct: capturedContextUsagePct,
    tools: toolsUsed,
  };
}

interface RunOneOpts {
  api: Api;
  chatId: number;
  projectPath: string;
  sessionId: string | null;
  prompt: PromptInput;
  displayText: string;
  config: Config;
  registry: Registry;
  store: Store;
  /** "interactive" (default) enables approval prompts; "cron" forces auto-approve. */
  origin?: "interactive" | "cron";
  onSessionId?: (id: string) => void;
}

/**
 * Run one task for a chat: mark active, stream it, mark finished, then drain the
 * next queued prompt (if any). The drain starts the next runOne synchronously
 * (registry.start is sync, before any await) so there's no window where a new
 * interactive message could start a concurrent run.
 */
export async function runOne(opts: RunOneOpts): Promise<RunOutcome> {
  const { api, chatId, projectPath, sessionId, prompt, displayText, config, registry, store, origin, onSessionId } = opts;

  // Guardrail: reject when the chat's daily spend/token quota is exhausted.
  // Single choke point for interactive, queued, and cron tasks.
  const quota = checkQuota(chatId, store, config);
  if (!quota.ok) {
    await api.sendMessage(chatId, `⚠️ ${quota.reason}`);
    return { status: "aborted", sessionId: undefined, tools: [] };
  }

  // Ask Claude Code to end its answer with a <next-actions> block we turn into
  // buttons. Appended only to what we dispatch — the original prompt stays in
  // the audit log and queue untouched.
  const directedPrompt: PromptInput = { ...prompt, text: `${prompt.text}\n${NEXT_ACTIONS_DIRECTIVE}` };

  const run = registry.start(chatId, projectPath, sessionId, prompt, displayText);
  const outcome = await runTurn({
    api,
    chatId,
    projectPath,
    sessionId,
    prompt: directedPrompt,
    config,
    registry,
    store,
    origin: origin ?? "interactive",
    abortSignal: run.abortController.signal,
    onSessionId,
  });

  // Audit: persist what ran, what it cost, and which tools it touched.
  store.insertAudit({
    id: run.taskId,
    chatId,
    sessionId: outcome.sessionId ?? null,
    prompt: prompt.text,
    tools: JSON.stringify(outcome.tools ?? []),
    status: outcome.status,
    costUsd: outcome.costUsd ?? null,
    durationMs: outcome.durationMs ?? null,
    inputTokens: outcome.inputTokens ?? null,
    outputTokens: outcome.outputTokens ?? null,
    contextUsagePct: outcome.contextUsagePct ?? null,
    startedAt: run.startedAt,
    endedAt: Date.now(),
  });

  registry.finish(chatId, outcome.status === "aborted" ? "aborted" : outcome.status === "error" ? "error" : "done");
  // Drain the next queued prompt (fire-and-forget; runOne starts synchronously).
  drainQueued({ api, chatId, config, registry, store });
  return outcome;
}

/** Pull the next queued prompt for a chat and start it (resolves the binding). */
function drainQueued(opts: { api: Api; chatId: number; config: Config; registry: Registry; store: Store }): void {
  const { api, chatId, config, registry, store } = opts;
  const next = registry.dequeue(chatId);
  if (!next) return;
  const binding = store.getBinding(chatId);
  if (!binding) {
    void api.sendMessage(chatId, "❌ No project bound - cleared the queue.");
    registry.dropQueue(chatId);
    return;
  }
  void runOne({
    api,
    chatId,
    projectPath: binding.projectPath,
    sessionId: binding.sessionId,
    prompt: next.prompt,
    displayText: next.displayText,
    config,
    registry,
    store,
    origin: "interactive",
    onSessionId: next.onSessionId,
  });
}

/**
 * Reject a task when the chat has exhausted its per-day spend or token quota.
 * Both caps are optional (undefined = no cap); the window resets at local
 * midnight. Returns ok:true when no cap applies or usage is within bounds.
 */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function checkQuota(
  chatId: number,
  store: Store,
  config: Config,
): { ok: true } | { ok: false; reason: string } {
  const costCap = config.claude.dailyCostCapUsd;
  const tokenCap = config.claude.dailyTokenCap;
  if (costCap === undefined && tokenCap === undefined) return { ok: true };
  const since = startOfToday();
  if (costCap !== undefined) {
    const used = store.sumCostSince(chatId, since);
    if (used >= costCap) {
      return { ok: false, reason: `今日花费额度已用尽（$${used.toFixed(2)} / $${costCap.toFixed(2)}）。` };
    }
  }
  if (tokenCap !== undefined) {
    const used = store.sumTokensSince(chatId, since);
    if (used >= tokenCap) {
      return { ok: false, reason: `今日 Token 额度已用尽（${used} / ${tokenCap}）。` };
    }
  }
  return { ok: true };
}

/** Format a millisecond duration as a compact Chinese string. */
function fmtDuration(ms?: number): string {
  if (ms === undefined || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}分${rs}秒` : `${m}分`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}小时${rm}分` : `${h}小时`;
}

/** Format tool usage as a compact summary, e.g. "🔧 调用 3 个工具（Bash ×2, Read ×1）". */
function fmtToolSummary(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (!entries.length) return "";
  const total = entries.reduce((acc, [, c]) => acc + c, 0);
  const detail = entries.map(([name, c]) => (c > 1 ? `${name} ×${c}` : name)).join(", ");
  return `🔧 调用 ${total} 个工具（${detail}）`;
}

/** Format token counts: <1k raw, ≥1k as "1.2K". */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/**
 * Decide whether the final answer deserves its own ② message.
 *
 * The last ① message already streams the final round's full text live, so
 * re-sending that same text as ② would show the content twice. We therefore
 * only emit ② when `answer` is non-empty AND differs from what ① already
 * showed (the last round's body). Returns false when they match — which is the
 * common case — so the duplicate is suppressed.
 */
export function shouldSendFinalAnswer(answer: string, lastRoundBody: string): boolean {
  const a = answer.trim();
  if (!a) return false;
  return a !== lastRoundBody.trim();
}

/**
 * Submit an interactive prompt: run immediately if idle, else enqueue. Sync and
 * non-blocking (runOne / the queued-notice are fire-and-forget) so grammY's
 * update loop isn't halted - /stop and other commands stay responsive mid-task.
 */
export function submitInteractive(opts: {
  api: Api;
  chatId: number;
  prompt: PromptInput;
  displayText: string;
  config: Config;
  registry: Registry;
  store: Store;
}): void {
  const { api, chatId, prompt, displayText, config, registry, store } = opts;
  if (registry.isActive(chatId)) {
    const pos = registry.enqueue(chatId, { prompt, displayText, onSessionId: (id) => store.setSessionId(chatId, id) });
    void api.sendMessage(chatId, `📋 Queued #${pos} (a task is running). /queue to view · /drop to cancel.`);
    return;
  }
  const binding = store.getBinding(chatId);
  if (!binding) {
    void api.sendMessage(chatId, "No project selected. Use /projects to pick one.");
    return;
  }
  void runOne({
    api,
    chatId,
    projectPath: binding.projectPath,
    sessionId: binding.sessionId,
    prompt,
    displayText,
    config,
    registry,
    store,
    origin: "interactive",
    onSessionId: (id) => store.setSessionId(chatId, id),
  });
}
