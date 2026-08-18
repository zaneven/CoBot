import type { Api } from "grammy";
import { type Config, DEFAULT_APPROVAL_SKIP_TOOLS } from "../config.js";
import type { Store, AuditLog } from "../store/db.js";
import type { Registry } from "../registry/registry.js";
import type { PromptInput, PermissionRequest, PermissionDecision } from "../claude/types.js";
import { runClaude } from "../claude/driver.js";
import { SilenceIndicator } from "./indicator.js";
import { sendRichText } from "../util/send.js";
import { logger } from "../util/logger.js";
import { approvalManager } from "./approval.js";
import { TaskDashboard } from "./dashboard.js";
import { buildNextActions, renderSuggestionKeyboard, extractNextActions, NEXT_ACTIONS_DIRECTIVE } from "./nextActions.js";

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

export function isRetryableError(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("s.thinking.length") ||
    lower.includes("thinking") ||
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("quota") ||
    lower.includes("overloaded") ||
    lower.includes("529") ||
    lower.includes("503") ||
    lower.includes("502") ||
    lower.includes("500") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("socket hang up") ||
    lower.includes("networkerror") ||
    lower.includes("fetcherror") ||
    lower.includes("api error:") ||
    lower.includes("request rejected")
  );
}

/**
 * True when the API rejected the resumed conversation because its history is
 * corrupt: an assistant turn that used tools lost its thinking block (a turn
 * cut off mid-thinking by an aborted stream leaves no valid block/signature),
 * so the API's "thinking must be preserved alongside tool_use" invariant fails
 * on replay. Retrying with the same `resume` id can never succeed - the only
 * way out is to drop the session and start a fresh one.
 */
export function isCorruptedResumeError(text: string): boolean {
  return text.includes("messages.content.thinking");
}

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
  taskId?: string;
  onSessionId?: (id: string) => void;
}): Promise<RunOutcome> {
  const { api, chatId, projectPath, sessionId, prompt, config, registry, store, origin, abortSignal, taskId, onSessionId } = opts;

  const indicator = new SilenceIndicator(api, chatId);

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
  let turnsExhausted = false;
  let abortedReason: "timeout" | "user" | undefined;
  let capturedSessionId: string | undefined;
  // Session to resume on each attempt. Starts as the chat's stored session; a
  // corrupted-resume failure clears it so the next attempt starts fresh.
  let resumeId: string | undefined = sessionId ?? undefined;
  const toolsUsed: string[] = [];
  let capturedCostUsd: number | undefined;
  let capturedDurationMs: number | undefined;
  let capturedInputTokens: number | undefined;
  let capturedOutputTokens: number | undefined;
  let capturedContextUsagePct: number | undefined;

  let lastNarration = "";
  const dashboard = new TaskDashboard(api, chatId, config.telegram.flushMs);
  let dashboardStarted = false;

  function cleanNarration(text: string): string {
    let clean = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    clean = clean.replace(/[`*#]/g, "");
    if (clean.length > 28) clean = clean.slice(0, 27) + "…";
    return clean;
  }

  // Trace events: capture detailed execution events for the admin trace view.
  const traceEvents: Array<{ eventType: string; eventData: string }> = [];
  const MAX_TRACE_EVENTS = 500;
  function pushTrace(eventType: string, data: Record<string, unknown>): void {
    if (traceEvents.length >= MAX_TRACE_EVENTS) return;
    traceEvents.push({ eventType, eventData: JSON.stringify(data) });
    // Mirror into the registry's in-memory live buffer so the admin page can
    // show a running task's trace in real time (before it's flushed to the
    // DB at done/error).
    if (taskId) registry.appendTrace(taskId, eventType, data);
  }
  // Accumulate text/thinking deltas so we store one block per round, not per-token.
  let traceTextAccum = "";
  let traceThinkingAccum = "";
  function flushTraceText(): void {
    if (traceTextAccum) {
      pushTrace("text", { content: traceTextAccum.slice(0, 2000) });
      traceTextAccum = "";
    }
  }
  function flushTraceThinking(): void {
    if (traceThinkingAccum) {
      pushTrace("thinking", { content: traceThinkingAccum.slice(0, 2000) });
      traceThinkingAccum = "";
    }
  }

  try {
    const MAX_RETRIES = 3;
    let attempt = 0;
    let success = false;

    while (attempt < MAX_RETRIES && !abortSignal.aborted && !success) {
    attempt++;
    let attemptError: string | null = null;
    let attemptAborted = false;

    try {
      for await (const ev of runClaude({
        prompt,
        cwd: projectPath,
        resume: resumeId,
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
            // Track every session we actually run in (a retry may fall back to
            // a fresh one) so the store and later attempts follow the move.
            if (ev.sessionId !== resumeId) {
              capturedSessionId = ev.sessionId;
              resumeId = ev.sessionId;
              onSessionId?.(ev.sessionId);
            }
            if (!dashboardStarted) {
              await dashboard.start();
              dashboardStarted = true;
            }
            pushTrace("init", { sessionId: ev.sessionId, model: ev.model });
            break;
          case "roundStart":
            if (!dashboardStarted) {
              await dashboard.start();
              dashboardStarted = true;
            }
            break;
          case "text":
            indicator.activity();
            // Update live action on dashboard from incoming narration
            lastNarration += ev.delta;
            if (lastNarration.length > 8) {
              const narr = cleanNarration(lastNarration);
              if (narr) dashboard.updateAction(narr);
            }
            // Accumulate text deltas for the trace; flush on tool boundaries and at the end.
            traceTextAccum += ev.delta;
            if (traceTextAccum.length > 2000) flushTraceText();
            break;
          case "thinking":
            indicator.activity();
            dashboard.recordThinking();
            traceThinkingAccum += ev.delta;
            if (traceThinkingAccum.length > 2000) flushTraceThinking();
            break;
          case "tool":
            indicator.activity();
            if (!toolsUsed.includes(ev.name)) toolsUsed.push(ev.name);
            dashboard.recordTool(ev.name, ev.summary);
            lastNarration = "";
            // Flush any accumulated text/thinking before this tool call.
            flushTraceText();
            flushTraceThinking();
            pushTrace("tool", { name: ev.name, summary: ev.summary });
            break;
          case "toolResult":
            indicator.activity();
            pushTrace("toolResult", { name: ev.name, content: ev.content.slice(0, 1500), isError: ev.isError });
            break;
          case "status":
            if (ev.status === "compacting") indicator.compacting();
            else indicator.activity();
            pushTrace("status", { status: ev.status });
            break;
          case "done":
            capturedCostUsd = ev.costUsd;
            let terminalStatus: string | undefined;
            capturedDurationMs = ev.durationMs;
            capturedInputTokens = ev.usage?.inputTokens;
            capturedOutputTokens = ev.usage?.outputTokens;
            capturedContextUsagePct = ev.contextUsagePct;

            if (ev.turnsExhausted) {
              // Reached the per-run agentic-turn cap (config.claude.maxTurns).
              // Not an error: the session is healthy, just ran out of turns
              // mid-work. Record it as an abort so it isn't flagged as an error
              // in the audit, and tell the user to send 继续 to resume.
              turnsExhausted = true;
              terminalStatus = "aborted";
              if (ev.contextUsagePct !== undefined) {
                registry.setContextUsage(chatId, ev.contextUsagePct);
              }
              await sendRichText(
                api,
                chatId,
                "⏺ 已达到本轮执行的轮次上限（maxTurns）。已完成的工作已保存，发送「继续」可接续完成剩余部分。",
              );
              await dashboard.finalize({
                status: "aborted",
                durationMs: ev.durationMs,
                costUsd: ev.costUsd,
                inputTokens: ev.usage?.inputTokens,
                outputTokens: ev.usage?.outputTokens,
                contextUsagePct: ev.contextUsagePct,
              });
            } else if (ev.isError) {
              attemptError = ev.text || "Execution error";
              terminalStatus = "error";
            } else if (ev.aborted) {
              attemptAborted = true;
              driverAborted = true;
              if (ev.abortedReason) abortedReason = ev.abortedReason;
              terminalStatus = "aborted";
            } else {
              success = true;
              terminalStatus = "done";

              // Build suggested next-action buttons to attach below the final deliverable message.
              let replyMarkup = undefined;
              if (ev.text) {
                try {
                  const suggestions = buildNextActions(ev.text);
                  if (suggestions.length) {
                    replyMarkup = renderSuggestionKeyboard(store, suggestions, chatId);
                  }
                } catch (err) {
                  logger.debug({ err: String(err) }, "next-action suggestions failed");
                }
              }

              // Deliver the complete, rich, authoritative final answer as Message 2 with next-action buttons below it.
              if (ev.text) {
                const full = extractNextActions(ev.text).cleaned.trim();
                if (full) {
                  await sendRichText(api, chatId, full, replyMarkup);
                }
              }

              if (ev.contextUsagePct !== undefined) {
                registry.setContextUsage(chatId, ev.contextUsagePct);
              }

              // Finalize the Dashboard Card (Message 1) into the settlement card.
              await dashboard.finalize({
                status: "done",
                durationMs: ev.durationMs,
                costUsd: ev.costUsd,
                inputTokens: ev.usage?.inputTokens,
                outputTokens: ev.usage?.outputTokens,
                contextUsagePct: ev.contextUsagePct,
              });
            }

            // Flush accumulated text/thinking for the trace.
            flushTraceText();
            flushTraceThinking();
            if (taskId && traceEvents.length > 0) {
              try { store.insertTraceEvents(taskId, traceEvents); } catch {}
            }
            if (taskId && terminalStatus) registry.finishLiveTrace(taskId, terminalStatus);
            break;
          case "error":
            attemptError = ev.message;
            flushTraceText();
            flushTraceThinking();
            if (taskId && traceEvents.length > 0) {
              try { store.insertTraceEvents(taskId, traceEvents); } catch {}
            }
            if (taskId) registry.finishLiveTrace(taskId, "error");
            break;
        }
      }
    } catch (err) {
      attemptError = err instanceof Error ? err.message : String(err);
      flushTraceText();
      flushTraceThinking();
      if (taskId && traceEvents.length > 0) {
        try { store.insertTraceEvents(taskId, traceEvents); } catch {}
      }
      if (taskId) registry.finishLiveTrace(taskId, "error");
    }

    if (success || attemptAborted || turnsExhausted || abortSignal.aborted) {
      break;
    }

    // A "missing messages.content.thinking" 400 means the resumed session's
    // history is corrupt (a turn was cut off mid-thinking by an earlier failed
    // attempt). Retrying with the same `resume` replays the same broken
    // history and fails identically - drop the session and retry from scratch
    // with the original prompt instead. Must be checked BEFORE the generic
    // retryable test: the 400 text contains "thinking"/"api error:" and would
    // otherwise be retried against the same poisoned session.
    if (attemptError && isCorruptedResumeError(attemptError) && attempt < MAX_RETRIES && !abortSignal.aborted) {
      logger.warn({ attempt, error: attemptError }, "resumed session history rejected, retrying in a fresh session");
      resumeId = undefined;
      capturedSessionId = undefined;
      dashboard.updateAction(`会话历史损坏，重建会话重试 (${attempt}/${MAX_RETRIES - 1})...`);
      await new Promise((res) => setTimeout(res, attempt * 2000));
      continue;
    }

    // Check if error is retryable
    if (attemptError && isRetryableError(attemptError) && attempt < MAX_RETRIES && !abortSignal.aborted) {
      const delayMs = attempt * 2000;
      logger.warn({ attempt, maxRetries: MAX_RETRIES, error: attemptError, delayMs }, "transient error encountered, retrying task");
      dashboard.updateAction(`上游异常，自动重试 (${attempt}/${MAX_RETRIES - 1}，${delayMs / 1000}s 后)...`);
      await new Promise((res) => setTimeout(res, delayMs));
      continue;
    }

    // Non-retryable error or exhausted retries
    hadError = true;
    if (attemptError) {
      logger.error({ attemptError, attempt }, "task failed with non-retryable error or exhausted retries");
      await dashboard.finalize({
        status: "error",
        errorMessage: attemptError,
      });
    } else if (attemptAborted) {
      await dashboard.finalize({
        status: "aborted",
        durationMs: capturedDurationMs,
        abortedReason: abortedReason === "timeout" ? `超时 (${Math.round(config.claude.taskTimeoutMs / 60000)}m)` : "用户中断",
      });
    }
    break;
  }
  } finally {
    clearInterval(typingTimer);
    await indicator.stop();
    // Safety net: deny any approval prompt still open for this chat (e.g. the
    // task aborted while waiting on a tap).
    approvalManager.cancelForChat(chatId, api);
  }

  return {
    status: hadError ? "error" : (driverAborted || turnsExhausted || abortSignal.aborted) ? "aborted" : "done",
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
    taskId: run.taskId,
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
