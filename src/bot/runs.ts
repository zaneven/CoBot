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
import { fmtDuration } from "../util/duration.js";
import { approvalManager } from "./approval.js";
import { buildNextActions, renderSuggestionKeyboard, extractNextActions, NextActionsStreamFilter, NEXT_ACTIONS_DIRECTIVE } from "./nextActions.js";

/**
 * Appended to every dispatched prompt. Asks the model to lay out longer answers
 * for readability instead of piling prose into one wall of text: blank lines
 * between paragraphs, **bold** subheadings, and a `---` rule between major
 * sections. The renderer already maps these to Telegram (horizontal rule, bold,
 * paragraph breaks), so no risky post-processing is needed — we just shape what
 * the model emits. Short / code-heavy answers are exempt so we don't force
 * structure onto trivial replies.
 */
const FORMAT_DIRECTIVE = `

[排版] 当你的回答较长（包含多个段落或多个要点）时，请注意排版以提升可读性：用空行分隔不同段落，避免大段文字堆叠在一起；用 **加粗** 作为小节标题；在主要章节之间用单独一行的 --- 分隔。简短的回答或纯代码/命令输出无需强行套用此结构。`;

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

  // ── Single live message (option A) ───────────────────────────────────────
  // The whole task streams into ONE Telegram message: a header line (how long
  // it thought + what tools it called) above the full answer body, edited in
  // place as the model thinks and calls tools. A long agentic task therefore
  // reads as one continuous reply instead of being sliced into one message per
  // tool-using turn (which made coherent answers look "truncated mid-sentence").
  // ② The separate "clean answer" message is gone — the live ① message already
  //   holds the entire answer, so re-sending it would just duplicate content.
  // ③ A done summary (token counts, cost, duration) still follows as its own msg.
  let streamer: TelegramStreamer | null = null;
  let taskStartMs = 0; // set on the first roundStart; drives the header clock
  let taskToolCounts: Record<string, number> = {}; // cumulative across the task

  // Streaming filter: hides a trailing <next-actions> block (if the model
  // emitted one) from the live ① message so it never shows in chat — we turn
  // that block into buttons instead.
  const nextFilter = new NextActionsStreamFilter();

  /** Build the task-level top-of-message header: how long the task has been
   *  running (cumulative) plus the running tool count. Shows "思考 中" until the
   *  task clock starts on the first roundStart. */
  function taskHeader(): string {
    const thinking = taskStartMs ? fmtDuration(Date.now() - taskStartMs) : "中";
    const bits: string[] = [`⏱️ 思考 ${thinking}`];
    const toolS = fmtToolSummary(taskToolCounts);
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
          // Single shared message: don't open a fresh streamer per round. The
          // first round lazily creates the one message we keep editing; later
          // rounds just keep appending to the same body. Tool counts stay
          // cumulative for the header; the task clock starts on first round.
          if (!streamer) {
            streamer = new TelegramStreamer(api, chatId, config.telegram.maxEditChars, config.telegram.flushMs);
            streamer.setHeader(taskHeader()); // taskStartMs still 0 → "思考 中"
            taskStartMs = Date.now();
          } else {
            // A new agentic turn begins — start its narration on a fresh line
            // so per-turn progress beats stack one-per-line (like the Claude
            // Code client) instead of gluing into one wall of text. No-op for
            // the first turn (handled above) and on an empty/already-broken
            // buffer, so it never adds blank stacking.
            streamer.newline();
          }
          break;
        case "text":
          indicator.activity();
          // Stream this turn's text into the single live ① message, but suppress
          // any trailing <next-actions> block the model emitted — we render that
          // as buttons instead of showing it inline.
          const disp = nextFilter.feed(ev.delta);
          if (streamer && disp) await streamer.text(disp);
          break;
        case "thinking":
          // Reasoning in progress. When the user opts into seeing the model's
          // chain-of-thought, stream it into the live ① message as a distinct
          // blockquote (tail-windowed so a long think stays compact) and treat
          // the deltas as activity so the silence heartbeat stays quiet.
          // Otherwise just show the transient "💭 Thinking…" progress marker.
          if (config.telegram.showThinking && streamer) {
            await streamer.thinking(ev.delta);
            indicator.activity();
          } else {
            indicator.thinking();
          }
          break;
        case "tool":
          indicator.activity();
          if (!toolsUsed.includes(ev.name)) toolsUsed.push(ev.name);
          taskToolCounts[ev.name] = (taskToolCounts[ev.name] ?? 0) + 1;
          // Live-update the header with the running (cumulative) tool count.
          if (streamer) streamer.setHeader(taskHeader());
          if (config.telegram.showToolCalls && streamer) {
            await streamer.toolLine(ev.name, ev.summary);
          }
          break;
        case "toolResult":
          indicator.activity();
          if (config.telegram.showToolCalls && streamer) await streamer.toolResult(ev.name, ev.content, ev.isError);
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
          // leaking a partial <next-actions> tag), then finalize the single
          // live message that already holds the whole answer.
          const tail = nextFilter.finish();
          if (tail.trailing) {
            if (streamer) await streamer.text(tail.trailing);
          }
          // Guarantee the live message ends with the COMPLETE final answer.
          // The streamed buffer is best-effort: when includePartialMessages is
          // on, the SDK's text deltas for the last turn don't always cover the
          // whole turn, so the authoritative full text lives only in `ev.text`
          // (r.result). If the live body is missing any of it, splice the
          // remainder in (longest-common-suffix merge, so no duplication) — this
          // is what prevents the "answer cut off mid-sentence at an inline-code
          // backtick" symptom that appeared after option A dropped the old
          // separate clean-answer message.
          if (streamer && !ev.isError && !ev.aborted && ev.text) {
            const full = extractNextActions(ev.text).cleaned.trim();
            if (full) streamer.ensureContains(full);
          }
          if (streamer) {
            streamer.setHeader(taskHeader());
            await streamer.finalize();
            streamer = null;
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
            // ① already streamed the whole answer live into one message, so the
            //   old separate "clean answer" (②) is no longer needed — re-sending
            //   it would just duplicate the content.
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
                  reply_markup: renderSuggestionKeyboard(store, suggestions, chatId),
                });
              }
            } catch (err) {
              logger.debug({ err: String(err) }, "next-action suggestions failed");
            }
          }
          break;
        case "error":
          hadError = true;
          if (streamer) {
            await streamer.finalize();
            streamer = null;
          }
          await sendRichText(api, chatId, `❌ ${ev.message}`);
          break;
      }
    }
  } catch (err) {
    hadError = true;
    logger.error({ err: String(err) }, "runTurn error");
    if (streamer) {
      await streamer.finalize();
      streamer = null;
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

  // Append two shaping directives to what we dispatch (the original prompt
  // stays untouched in the audit log and queue): a layout directive so longer
  // answers render with paragraphs / headings / rules instead of a wall of
  // text, and a request to end with a <next-actions> block we turn into buttons.
  const directedPrompt: PromptInput = { ...prompt, text: `${prompt.text}\n${FORMAT_DIRECTIVE}\n${NEXT_ACTIONS_DIRECTIVE}` };

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

/** Pull the next queued prompt for a chat and start it (resolves the binding or
 *  the cron job the item was queued from). */
function drainQueued(opts: { api: Api; chatId: number; config: Config; registry: Registry; store: Store }): void {
  const { api, chatId, config, registry, store } = opts;
  const next = registry.dequeue(chatId);
  if (!next) return;

  // Cron-queued item: resume the originating job's session and bump its last_run.
  if (next.origin === "cron" && next.cronJobId) {
    const job = store.getCron(next.cronJobId);
    if (!job) return; // job was deleted while queued; drop silently
    store.setCronLastRun(job.id, Date.now());
    void runOne({
      api,
      chatId,
      projectPath: job.projectPath,
      sessionId: job.claudeSessionId,
      prompt: next.prompt,
      displayText: next.displayText,
      config,
      registry,
      store,
      origin: "cron",
      onSessionId: (id) => store.setCronSessionId(job.id, id),
    });
    return;
  }

  const binding = store.getBinding(chatId);
  if (!binding) {
    void api.sendMessage(chatId, "❌ No project bound - cleared the queue.");
    registry.dropQueue(chatId);
    return;
  }
  void runOne({
    api,
    chatId,
    projectPath: next.projectPath ?? binding.projectPath,
    sessionId: binding.sessionId,
    prompt: next.prompt,
    displayText: next.displayText,
    config,
    registry,
    store,
    origin: "interactive",
    onSessionId: (id) => store.setSessionId(chatId, id),
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
    const binding = store.getBinding(chatId);
    const pos = registry.enqueue(chatId, {
      prompt,
      displayText,
      projectPath: binding?.projectPath ?? null,
      origin: "interactive",
    });
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
