import type { Api } from "grammy";
import { type Config, DEFAULT_APPROVAL_SKIP_TOOLS } from "../config.js";
import type { Store, AuditLog } from "../store/db.js";
import type { Registry } from "../registry/registry.js";
import type { PromptInput, PermissionRequest, PermissionDecision, UserDialogRequest, UserDialogResult } from "../claude/types.js";
import { runAgent } from "../driver/index.js";
import { SilenceIndicator } from "./indicator.js";
import { sendRichText } from "../util/send.js";
import { logger } from "../util/logger.js";
import { approvalManager } from "./approval.js";
import { dialogManager } from "./dialog.js";
import { TaskDashboard } from "./dashboard.js";
import { TodoPanel } from "./todoPanel.js";
import { TelegramStreamer } from "./streaming.js";
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

[排版] 请使用 markdown 格式回复`;

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
  engine?: string;
  /** Model the run actually used, as reported by the driver's init event. */
  model?: string;
  tools: string[];
}

/**
 * Resolve the engine backend and model for a chat's next run: the chat's
 * per-chat overrides (/engine, /models) win, else the config defaults. The
 * model may be undefined, meaning "let the engine CLI pick its own default".
 */
export function resolveEngineModel(store: Store, config: Config, chatId: number): { engine: Config["backend"]; model: string | undefined } {
  const binding = store.getBinding(chatId);
  const engine = binding?.engine ?? config.backend;
  const model = binding?.model ?? (engine === "opencode" ? config.opencode?.model : engine === "agy" ? config.agy?.model : config.claude.model);
  return { engine, model };
}

/**
 * Run one agentic turn (Claude Code or OpenCode): stream the assistant output into the chat and
 * persist the result. Does NOT touch the registry's active/queue state - the
 * caller (runOne) owns start/finish + draining.
 */
export async function runTurn(opts: {
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
  /** Test seam: inject a fake driver instead of the real agent driver. */
  runClaudeFn?: typeof runAgent;
}): Promise<RunOutcome> {
  const { api, chatId, projectPath, sessionId, prompt, config, registry, store, origin, abortSignal, taskId, onSessionId, runClaudeFn } = opts;
  const driver = runClaudeFn ?? runAgent;

  const indicator = new SilenceIndicator(api, chatId);
  // Engine backend + model for this run: chat overrides win, else config defaults.
  // Model undefined means "don't set options.model" — the driver CLI picks its own default.
  const { engine, model } = resolveEngineModel(store, config, chatId);

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

  // AskUserQuestion relay: surface the model's question as a Telegram inline
  // keyboard so the user can tap an option (or send freeform text via "其他").
  // Only for interactive tasks — cron runs leave it unset so AskUserQuestion
  // degrades to the SDK's no-dialog default, safe for unattended headless.
  const userDialogHandler = origin !== "cron"
    ? (req: UserDialogRequest, sig: AbortSignal): Promise<UserDialogResult> =>
        dialogManager.ask(req, {
          api,
          chatId,
          indicator,
          timeoutMs: approvalCfg?.timeoutMs ?? 300000,
        }, sig)
    : undefined;

  // Telegram's "typing…" indicator expires after ~5 s; refresh a little sooner.
  // Fire once immediately then every 4.5 s. Non-critical — errors are swallowed.
  const typingTimer = setInterval(() => api.sendChatAction(chatId, "typing").catch(() => undefined), 4500);
  typingTimer.ref();   // keep the process alive while the task runs
  api.sendChatAction(chatId, "typing").catch(() => undefined);

  logger.info({ chatId, project: projectPath, engine, model: model ?? "(cli default)", resume: sessionId ?? null }, "starting agent task");

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
  // Model the engine actually picked, as reported by the init event (may differ
  // from the requested `model`, which can be undefined = CLI default).
  let capturedModel: string | undefined;

  let lastNarration = "";
  const dashboard = new TaskDashboard(api, chatId, config.telegram.flushMs, { engine, model });
  let dashboardStarted = false;
  // Live Claude-Code-style task-tracker panel: the first TodoWrite call from
  // the model sends a dedicated message, and later calls edit it in place.
  const todoPanel = new TodoPanel(api, chatId, config.telegram.flushMs);
  // When the trace-text feature is on, the intermediate narration is streamed
  // progressively into its own message (a growing bullet list of completed
  // blocks) as the run proceeds, then finalized into that same message holding
  // the full "执行过程" plus the summary and next-action buttons. When off,
  // only the one-shot summary is sent at the end (the pre-feature behavior).
  const traceStreamer: TelegramStreamer | undefined = config.claude.showTraceText
    ? new TelegramStreamer(api, chatId, undefined, config.telegram.flushMs)
    : undefined;

  function cleanNarration(text: string): string {
    let clean = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    clean = clean.replace(/[`*#]/g, "");
    if (clean.length > 28) clean = clean.slice(0, 27) + "…";
    return clean;
  }

  type TraceEventItem = { eventType: string; eventData: string; createdAt: number };
  const traceEvents: TraceEventItem[] = [];
  function pushTrace(eventType: string, data: Record<string, unknown>): void {
    const createdAt = Date.now();
    const eventData = JSON.stringify(data);
    traceEvents.push({ eventType, eventData, createdAt });
    if (taskId) {
      registry.appendTrace(taskId, eventType, data);
    }
  }
  // Accumulate text/thinking deltas so we store one block per round, not per-token.
  let traceTextAccum = "";
  let traceThinkingAccum = "";
  // The narration text blocks flushed to the trace (one per tool boundary / end).
  // Kept separately from `traceEvents` so the reply can append these intermediate
  // steps when config.claude.showTraceText is on.
  const traceTexts: string[] = [];
  function flushTraceText(): void {
    if (traceTextAccum) {
      const content = traceTextAccum.slice(0, 2000);
      pushTrace("text", { content });
      traceTexts.push(content);
      traceTextAccum = "";
    }
  }
  function flushTraceThinking(): void {
    if (traceThinkingAccum) {
      pushTrace("thinking", { content: traceThinkingAccum.slice(0, 2000) });
      traceThinkingAccum = "";
    }
  }

  // Render the already-flushed narration blocks as the live "执行过程" body for
  // the trace streamer. Only completed blocks (in `traceTexts`) are shown live
  // — the in-progress round's text stays in `traceTextAccum` until the next
  // boundary, so the running message grows one block at a time and the final
  // answer never appears mid-stream (it would otherwise collapse/reformat at
  // done). Returns "" until at least one block exists, so the streamer's first
  // real render happens only once there's something to show.
  function renderLiveTrace(): string {
    const lists = traceTexts.map((t) => toBulletList(t.trim())).filter(Boolean);
    if (lists.length === 0) return "";
    return `##【执行过程】\n\n${lists.join("\n\n---\n\n")}`;
  }
  // Push the current live-trace body into the streamer (throttled/deferred
  // internally), so each tool boundary re-renders the growing bullet list. A
  // no-op when the feature is off or there's nothing to show yet.
  function pushTraceDisplay(): void {
    if (!traceStreamer) return;
    const body = renderLiveTrace();
    if (body) void traceStreamer.setContent(body);
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
      for await (const ev of driver({
        prompt,
        cwd: projectPath,
        backend: engine,
        resume: resumeId,
        model,
        permissionMode: config.claude.permissionMode,
        allowedTools: config.claude.allowedTools,
        allowDangerouslySkipPermissions:
          config.claude.permissionMode === "bypassPermissions" && config.claude.allowDangerousSkip,
        maxTurns: config.claude.maxTurns,
        signal: abortSignal,
         timeoutMs: engine === "opencode" ? (config.opencode?.timeoutMs ?? config.claude.taskTimeoutMs) : engine === "agy" ? (config.agy?.timeoutMs ?? config.claude.taskTimeoutMs) : config.claude.taskTimeoutMs,
         opencodePath: config.opencode?.path,
         opencodeAutoApprove: config.opencode?.autoApprove,
         agent: engine === "opencode" ? config.opencode?.agent : engine === "agy" ? config.agy?.agent : undefined,
         agyPath: config.agy?.path,
         agyAutoApprove: config.agy?.autoApprove,
         agyEffort: config.agy?.effort,
        canUseToolHandler,
        userDialogHandler,
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
            // The init event reports the model the engine actually resolved
            // (the requested model may be undefined = CLI default) — surface
            // it on the dashboard card and in the audit.
            capturedModel = ev.model || model;
            dashboard.setEngineModel(engine, capturedModel);
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
            if (traceTextAccum.length > 2000) {
              flushTraceText();
              pushTraceDisplay();
            }
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
            pushTraceDisplay();
            pushTrace("tool", { name: ev.name, summary: ev.summary });
            break;
          case "toolResult":
            indicator.activity();
            pushTrace("toolResult", { name: ev.name, content: ev.content.slice(0, 1500), isError: ev.isError });
            break;
          case "todos":
            indicator.activity();
            todoPanel.update(ev.todos);
            pushTrace("todos", { todos: ev.todos });
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
              // Finalize the dashboard into the settlement card here, mirroring
              // the turnsExhausted/success branches which also finalize inside
              // the switch. The post-loop `else if (attemptAborted)` finalize
              // below is UNREACHABLE for this case: `attemptAborted` triggers
              // the `break` at the loop guard, exiting before that code runs.
              // Without this, a timed-out (or /stop-aborted) task left the
              // "任务进行中" card frozen forever with no notification — the user
              // saw silence and assumed the task had hung.
              await dashboard.finalize({
                status: "aborted",
                durationMs: capturedDurationMs,
                abortedReason: abortedReason === "timeout" ? `超时 (${Math.round(config.claude.taskTimeoutMs / 60000)}m)` : "用户中断",
              });
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

              // Deliver the complete, rich, authoritative final answer with
              // next-action buttons below it. When the trace-text feature is on,
              // the live "执行过程" message that grew block-by-block during the
              // run is finalized into this same message holding the full process
              // list plus the summary plus the buttons (one message, no jarring
              // collapse — the final answer never appeared mid-stream).
              let finalText = ev.text ? extractNextActions(ev.text).cleaned.trim() : "";
              if (traceStreamer) {
                // CRITICAL ordering: flush the final round's narration into
                // traceTexts BEFORE buildTraceReply, so its "drop the last
                // block" dedup drops the final round (which ≈ summary) instead
                // of a legitimate intermediate block. (Pre-fix the final round's
                // text was still in traceTextAccum and only flushed after this
                // branch, so the dedup dropped the wrong block and the final
                // round — which ≈ summary — survived as a duplicate bullet.)
                flushTraceText();
                if (finalText) {
                  finalText = buildTraceReply(traceTexts, finalText);
                } else {
                  // No summary (edge: empty result) — leave the live process
                  // list as the final body rather than an empty message.
                  finalText = renderLiveTrace();
                }
                if (finalText) await traceStreamer.setContent(finalText);
                await traceStreamer.finalize(replyMarkup);
              } else if (finalText) {
                await sendRichText(api, chatId, finalText, replyMarkup);
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
    // Safety net: cancel any AskUserQuestion still open for this chat (e.g.
    // the task aborted while waiting on a tap) so the worker isn't left parked.
    dialogManager.cancelForChat(chatId, api);
    // Finalize the live "执行过程" message. No-op when the feature is off, and
    // idempotent when the success branch already finalized it (the finalize()
    // guard returns early). For a terminal error/abort/turns-exhausted it pins
    // the last live render as the final state — pushing the latest flushed
    // blocks first so a partial final narration shows as a last bullet instead
    // of leaving the message mid-render. Between retries this doesn't run, so
    // the streamer stays live and the retried attempt appends to it.
    if (traceStreamer) {
      try {
        pushTraceDisplay();
        await traceStreamer.finalize();
      } catch {
        /* best effort — never block the return on a telegram edit failure */
      }
    }
    // Pin the live task-tracker panel at its final state. No-op when the model
    // never produced a todo plan, and idempotent if already finalized.
    try {
      await todoPanel.finalize();
    } catch {
      /* best effort */
    }
  }

  return {
    status: hadError ? "error" : (driverAborted || turnsExhausted || abortSignal.aborted) ? "aborted" : "done",
    sessionId: capturedSessionId,
    costUsd: capturedCostUsd,
    durationMs: capturedDurationMs,
    inputTokens: capturedInputTokens,
    outputTokens: capturedOutputTokens,
    contextUsagePct: capturedContextUsagePct,
    engine,
    model: capturedModel,
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
  /** Test seam: inject a fake driver instead of the real agent driver (forwarded to runTurn). */
  runClaudeFn?: typeof runAgent;
}

/**
 * Run one task for a chat: mark active, stream it, mark finished, then drain the
 * next queued prompt (if any). The drain starts the next runOne synchronously
 * (registry.start is sync, before any await) so there's no window where a new
 * interactive message could start a concurrent run.
 */
export async function runOne(opts: RunOneOpts): Promise<RunOutcome> {
  const { api, chatId, projectPath, sessionId, prompt, displayText, config, registry, store, origin, onSessionId, runClaudeFn } = opts;

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

  // Resolve the engine/model up front so the active-run record (and hence the
  // admin tasks view) shows what this run was dispatched with. runTurn resolves
  // the same values again for its dispatch options.
  const { engine, model } = resolveEngineModel(store, config, chatId);
  const run = registry.start(chatId, projectPath, sessionId, prompt, displayText, engine, model);
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
    runClaudeFn,
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
    engine: outcome.engine ?? null,
    model: outcome.model ?? null,
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
 * Build the final reply when `claude.showTraceText` is on: prepend the
 * intermediate narration blocks from the execution trace (`text` trace events),
 * separated by divider lines, before the summary.
 *
 * The last traced text block for a run is the final round's narration, which
 * essentially duplicates `summary`, so it's excluded — only what happened
 * *between* the intermediate steps is appended. If there are no meaningful
 * intermediate blocks (e.g. a single-round run), the summary is returned
 * unchanged so nothing is disturbed.
 */
export function buildTraceReply(texts: string[], summary: string): string {
  const s = summary.trim();
  const intermediate = texts.length > 1 ? texts.slice(0, -1) : [];
  const lists = intermediate
    .map((t) => toBulletList(t.trim()))
    .filter(Boolean);
  if (lists.length === 0) return s;
  return `##【执行过程】\n\n${lists.join("\n\n---\n\n")}\n\n---\n\n${s}`;
}

/**
 * Render one narration block as a Markdown blockquote: prefix each non-blank line
 * with "> ". Existing list/quote markers ("- ", "* ", "1. ", "> ") and trailing
 * colons (":", "：") are stripped first. Blank lines collapse so the block stays tight.
 */
function toBulletList(text: string): string {
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[-*+>]\s+|^\d+[.)]\s*/, "").replace(/[:：]\s*$/, "").trim())
    .filter(Boolean)
    .map((l) => `> ${l}`)
    .join("\n");
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
