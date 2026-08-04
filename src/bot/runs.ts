import type { Api } from "grammy";
import type { Config } from "../config.js";
import type { Store } from "../store/db.js";
import type { Registry } from "../registry/registry.js";
import type { PromptInput } from "../claude/types.js";
import { runClaude } from "../claude/driver.js";
import { TelegramStreamer } from "./streaming.js";
import { SilenceIndicator } from "./indicator.js";
import { logger } from "../util/logger.js";

export interface RunOutcome {
  status: "done" | "aborted" | "error";
  sessionId?: string;
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
  abortSignal: AbortSignal;
  onSessionId?: (id: string) => void;
}): Promise<RunOutcome> {
  const { api, chatId, projectPath, sessionId, prompt, config, registry, abortSignal, onSessionId } = opts;

  const streamer = new TelegramStreamer(api, chatId, config.telegram.maxEditChars, config.telegram.flushMs);
  const indicator = new SilenceIndicator(api, chatId);
  indicator.start();

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
      signal: abortSignal,
      timeoutMs: config.claude.taskTimeoutMs,
    })) {
      switch (ev.kind) {
        case "init":
          if (!sessionId) {
            capturedSessionId = ev.sessionId;
            onSessionId?.(ev.sessionId);
          }
          break;
        case "text":
          indicator.activity();
          await streamer.text(ev.delta);
          break;
        case "tool":
          indicator.activity();
          if (config.telegram.showToolCalls) await streamer.toolLine(ev.name, ev.summary);
          break;
        case "toolResult":
          indicator.activity();
          if (config.telegram.showToolCalls) await streamer.toolResult(ev.name, ev.content, ev.isError);
          break;
        case "status":
          if (ev.status === "compacting") indicator.compacting();
          else indicator.activity();
          break;
        case "done":
          await streamer.finalize();
          if (ev.contextUsagePct !== undefined) {
            registry.setContextUsage(chatId, ev.contextUsagePct);
          }
          if (ev.aborted) {
            driverAborted = true;
            if (ev.abortedReason) abortedReason = ev.abortedReason;
          }
          if (ev.isError) {
            logger.error({ text: ev.text, costUsd: ev.costUsd, durationMs: ev.durationMs }, "claude task finished with error");
            const detail = ev.text ? `\n\`\`\`\n${ev.text.slice(0, 1000)}\n\`\`\`` : "";
            await api.sendMessage(chatId, `⚠️ Finished with error.${detail}`);
          } else if (ev.aborted) {
            const reason =
              abortedReason === "timeout" ? ` (timed out after ${Math.round(config.claude.taskTimeoutMs / 60000)}m)` : "";
            await api.sendMessage(chatId, `⏹ Interrupted${reason}.`);
          } else {
            const parts: string[] = ["✅ Done"];
            if (ev.usage) parts.push(`↑${fmtTokens(ev.usage.inputTokens)} ↓${fmtTokens(ev.usage.outputTokens)}`);
            if (ev.contextUsagePct !== undefined) parts.push(`📊 ${ev.contextUsagePct}%`);
            if (ev.costUsd) parts.push(`$${ev.costUsd.toFixed(4)}`);
            if (ev.durationMs) parts.push(`${(ev.durationMs / 1000).toFixed(1)}s`);
            await api.sendMessage(chatId, parts.join(" · "));
          }
          break;
        case "error":
          hadError = true;
          await streamer.finalize();
          await api.sendMessage(chatId, `❌ ${ev.message}`);
          break;
      }
    }
  } catch (err) {
    hadError = true;
    logger.error({ err: String(err) }, "runTurn error");
    await streamer.finalize();
    await api.sendMessage(chatId, `❌ Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearInterval(typingTimer);
    await indicator.stop();
  }

  return {
    status: hadError ? "error" : (driverAborted || abortSignal.aborted) ? "aborted" : "done",
    sessionId: capturedSessionId,
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
  onSessionId?: (id: string) => void;
}

/**
 * Run one task for a chat: mark active, stream it, mark finished, then drain the
 * next queued prompt (if any). The drain starts the next runOne synchronously
 * (registry.start is sync, before any await) so there's no window where a new
 * interactive message could start a concurrent run.
 */
export async function runOne(opts: RunOneOpts): Promise<RunOutcome> {
  const { api, chatId, projectPath, sessionId, prompt, displayText, config, registry, store, onSessionId } = opts;
  const run = registry.start(chatId, projectPath, sessionId, prompt, displayText);
  const outcome = await runTurn({
    api,
    chatId,
    projectPath,
    sessionId,
    prompt,
    config,
    registry,
    abortSignal: run.abortController.signal,
    onSessionId,
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
    onSessionId: next.onSessionId,
  });
}

/** Format token counts: <1k raw, ≥1k as "1.2K". */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
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
    onSessionId: (id) => store.setSessionId(chatId, id),
  });
}
