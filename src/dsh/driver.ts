import type { DriverEvent, RunParams, MediaAttachment } from "../claude/types.js";
import { summarizeToolInput, shouldStartRound } from "../opencode/driver.js";
import { parseTodos } from "../claude/driver.js";
import { buildDshEnv } from "./env.js";

// Re-exported so the driver module stays the one import surface for engine tests.
export { buildDshEnv } from "./env.js";
import { logger } from "../util/logger.js";
import { getSharedDshClient, type DshAcpClient, type PermissionHandler } from "./client.js";
import type { AcpConfigOption, AcpSessionUpdate } from "./types.js";
import { mapDshModelValue, normalizeDshModelId } from "./models.js";
import { readLastTurnUsage } from "./sessions.js";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

/** Resolve the dsh executable: explicit config path, then DSH_PATH, then PATH. */
export function resolveDshExecutable(customPath?: string): string {
  if (customPath && existsSync(customPath)) return customPath;
  const envPath = process.env.DSH_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  for (const p of ["/opt/homebrew/bin/dsh", "/usr/local/bin/dsh", "/usr/bin/dsh"]) {
    if (existsSync(p)) return p;
  }
  return "dsh";
}

/**
 * Turn the bot's {@link MediaAttachment}s into prompt text for dsh.
 *
 * The shipped ACP profile advertises `promptCapabilities.image: false`, so
 * images/PDF cannot ride the wire. Text attachments are inlined (same policy as
 * the Claude driver) and unsupported media is reported to the model explicitly
 * rather than silently dropped — the model then asks the user to paste the
 * content as text instead of pretending it saw the file.
 */
export function flattenDshPrompt(text: string, media?: MediaAttachment[]): string {
  if (!media || media.length === 0) return text;
  const parts: string[] = [];
  for (const m of media) {
    if (m.kind === "text") {
      const body = m.data.toString("utf8");
      const truncated = body.length > 200_000 ? body.slice(0, 200_000) + "\n…[truncated]" : body;
      parts.push(`📎 ${m.fileName} (${m.mediaType || "text"})\n\`\`\`\n${truncated}\n\`\`\``);
    } else {
      parts.push(
        `⚠️ 用户随消息附带了一个${m.kind === "image" ? "图片" : "PDF 文档"}（${m.fileName ?? "未命名"}），但当前 DeepSeek Harness 引擎的 ACP 接口不支持图片/文档输入，内容未送达。请让用户改用文字描述，或切换到 Claude / Antigravity 引擎重发。`,
      );
    }
  }
  return [text, ...parts].filter(Boolean).join("\n\n");
}

/** Friendly rewrite of the runtime's error codes (same spirit as the Claude driver). */
export function formatDshError(text: string): string {
  if (!text) return "DeepSeek Harness 执行发生错误";
  if (/MISSING_CREDENTIAL|no API key/i.test(text)) {
    return "⚠️ DeepSeek Harness 缺少凭据：请在 dsh 的 Web/Desktop 里登录 DeepSeek 账号，或为 Bot 设置 DEEPSEEK_API_KEY 环境变量";
  }
  if (/Authentication Fails|invalid api key|"AUTH"|401/i.test(text)) {
    return "⚠️ DeepSeek API 鉴权失败 (401)：API Key 无效或已过期，请检查 DEEPSEEK_API_KEY / dsh 账号登录状态";
  }
  if (/QUOTA|exceeded.*quota/i.test(text)) {
    return "⚠️ DeepSeek API 额度不足：请检查账号余额或套餐用量";
  }
  if (/RATE_LIMIT|429/i.test(text)) {
    return "⚠️ DeepSeek API 限流 (429)：请稍后重试";
  }
  if (/ENOENT|spawn dsh|failed to spawn/i.test(text)) {
    return `⚠️ 无法启动 DeepSeek Harness：${text.slice(0, 200)}`;
  }
  return text;
}

/** Per-run state accumulated from ACP updates. */
export interface RunState {
  roundActive: boolean;
  pendingNewRound: boolean;
  /** Text of the round that started most recently — the user-facing answer. */
  lastRoundText: string;
  /** Every assistant text chunk of the turn, in order (fallback for the answer). */
  allText: string;
  /** Tool display names by callId, so late tool results can be labelled. */
  toolNames: Map<string, string>;
  /** Latest context-window occupancy reported by `usage_update`. */
  contextUsed?: number;
  contextSize?: number;
}

export function newRunState(): RunState {
  return {
    roundActive: false,
    pendingNewRound: true,
    lastRoundText: "",
    allText: "",
    toolNames: new Map(),
  };
}

/** Extract readable text from an ACP tool result's content blocks. */
export function acpToolResultText(update: AcpSessionUpdate | undefined): string {
  if (!update || update.sessionUpdate !== "tool_call_update") return "";
  const blocks = update.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((b) => {
      if (b && typeof b === "object" && b.type === "content") {
        const inner = (b as { content?: { text?: string } }).content;
        return typeof inner?.text === "string" ? inner.text : "";
      }
      if (b && typeof b === "object" && b.type === "diff") {
        const p = (b as { path?: string }).path;
        return p ? `[diff ${p}]` : "[diff]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Map one ACP `session/update` into {@link DriverEvent}s plus state transitions.
 * Pure apart from mutating the passed state — unit-testable without a runtime.
 */
export function mapDshUpdate(update: AcpSessionUpdate, state: RunState): DriverEvent[] {
  const events: DriverEvent[] = [];
  const kind = update.sessionUpdate;

  if (kind === "agent_thought_chunk") {
    const text = (update as { content?: { text?: string } }).content?.text;
    if (!text) return events;
    const r = shouldStartRound(state, "thinking");
    if (r.start) {
      events.push({ kind: "roundStart" });
      state.lastRoundText = "";
    }
    state.roundActive = r.roundActive;
    state.pendingNewRound = r.pendingNewRound;
    events.push({ kind: "thinking", delta: text });
    return events;
  }

  if (kind === "agent_message_chunk") {
    const text = (update as { content?: { text?: string } }).content?.text;
    if (!text) return events;
    const r = shouldStartRound(state, "text");
    if (r.start) {
      events.push({ kind: "roundStart" });
      state.lastRoundText = "";
    }
    state.roundActive = r.roundActive;
    state.pendingNewRound = r.pendingNewRound;
    state.lastRoundText += text;
    state.allText += text;
    events.push({ kind: "text", delta: text });
    return events;
  }

  if (kind === "tool_call") {
    const u = update as { toolCallId?: string; title?: string; rawInput?: unknown };
    const name = u.title ?? "tool";
    if (u.toolCallId) state.toolNames.set(u.toolCallId, name);
    const r = shouldStartRound(state, "tool");
    state.roundActive = r.roundActive;
    state.pendingNewRound = r.pendingNewRound;
    // Todo plans: dsh's todo_write carries the same {todos:[{content,status}]}
    // shape as Claude's TodoWrite, so the shared parser feeds the panel directly.
    if (name === "todo_write") {
      const todos = parseTodos(u.rawInput);
      if (todos) events.push({ kind: "todos", todos });
    }
    events.push({ kind: "tool", name, summary: summarizeToolInput(name, u.rawInput) || name });
    return events;
  }

  if (kind === "tool_call_update") {
    const u = update as { toolCallId?: string; status?: string };
    // Intermediate statuses ("in_progress") are not results; dsh emits one
    // terminal status per call ("completed" / "failed").
    const status = (u.status ?? "").toLowerCase();
    if (status !== "completed" && status !== "failed" && status !== "error") return events;
    const name = (u.toolCallId ? state.toolNames.get(u.toolCallId) : undefined) ?? "tool";
    const isError = status !== "completed";
    const text = acpToolResultText(update);
    if (!text && !isError) return events;
    events.push({ kind: "toolResult", name, content: text || "(error)", isError });
    return events;
  }

  if (kind === "usage_update") {
    const u = update as { used?: number; size?: number };
    if (typeof u.used === "number") state.contextUsed = u.used;
    if (typeof u.size === "number") state.contextSize = u.size;
    return events;
  }

  return events;
}

/** Percentage of the context window in use, from the last `usage_update`. */
export function dshContextUsagePct(state: RunState): number | undefined {
  if (!state.contextUsed || !state.contextSize || state.contextSize <= 0) return undefined;
  return Math.round((state.contextUsed / state.contextSize) * 100);
}

/** The user-facing final answer: the last round's text, falling back to all text. */
export function dshFinalText(state: RunState): string {
  const last = state.lastRoundText.trim();
  return last || state.allText.trim();
}

/**
 * Model value the ACP runtime expects for `session/set_config_option`.
 *
 * ACP only accepts values it advertised (an unknown one rejects the whole
 * call), so a configured id is matched against the live catalog first; when it
 * is not there it is encoded as its `["provider","model"]` tuple and left to the
 * runtime to reject, which the caller logs without failing the run.
 */
export function resolveModelSelection(model: string | undefined, options: AcpConfigOption[]): string | undefined {
  if (!model) return undefined;
  const advertised = collectModelValues(options.find((o) => o.id === "model"));
  const match = advertised.find((v) => normalizeDshModelId(v) === normalizeDshModelId(model));
  return match ?? mapDshModelValue(model);
}

function collectModelValues(option: AcpConfigOption | undefined): string[] {
  const entries = (option as { options?: unknown } | undefined)?.options;
  const out: string[] = [];
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const n = node as { value?: unknown; options?: unknown };
      if (typeof n.value === "string") out.push(n.value);
      else walk(n.options);
    }
  };
  walk(entries);
  return out;
}

/**
 * Drive one DeepSeek Harness turn over ACP, yielding {@link DriverEvent}s.
 *
 * The runtime is shared process-wide; each run owns one ACP session (new, or the
 * resumed id). Text arrives in whole assistant messages per round — ACP only
 * pushes committed chunks — so the UI streams per block rather than per token.
 */
export async function* runDsh(params: RunParams): AsyncGenerator<DriverEvent> {
  const client = getSharedDshClient({
    executable: resolveDshExecutable(params.dshPath),
    env: buildDshEnv({ permissionMode: params.dshPermissionPreset }),
  });
  const state = newRunState();
  const promptText = flattenDshPrompt(params.prompt.text, params.prompt.media);

  let sessionId = params.resume || "";
  let unsub: (() => void) | undefined;
  let dropPermission: (() => void) | undefined;
  let timedOut = false;

  const abortController = new AbortController();
  if (params.signal) {
    if (params.signal.aborted) abortController.abort();
    else params.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  if (params.timeoutMs && params.timeoutMs > 0) {
    watchdog = setTimeout(() => {
      timedOut = true;
      logger.warn({ timeoutMs: params.timeoutMs, sessionId }, "dsh task timed out, cancelling");
      abortController.abort(new Error("task timed out"));
    }, params.timeoutMs);
    watchdog.unref?.();
  }
  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = undefined;
  };

  try {
    await client.init();

    // A resume rejects a session recorded in another cwd (the runtime pins the
    // workspace per session) — e.g. a chat that kept its session id across a
    // project switch. Fall back to a fresh session there, like /new, so the task
    // still runs instead of failing the user with a protocol error.
    const opened = await openOrResume(client, params.resume, params.cwd).catch(async (err: unknown) => {
      if (!params.resume) throw err;
      logger.warn({ err: String(err), sessionId: params.resume, cwd: params.cwd }, "dsh session resume failed; starting a fresh session");
      return client.newSession(params.cwd);
    });
    sessionId = opened.sessionId ?? sessionId;
    if (!sessionId) throw new Error("dsh returned no session id");

    const options = opened.configOptions ?? client.configOptions();
    const modelValue = resolveModelSelection(params.model, options);
    if (modelValue) {
      await client.setModel(sessionId, modelValue).catch((err: unknown) => {
        logger.warn({ err: String(err), model: params.model }, "dsh model selection rejected");
      });
    }
    if (params.dshEffort) {
      await client.setReasoningEffort(sessionId, params.dshEffort).catch((err: unknown) => {
        logger.warn({ err: String(err), effort: params.dshEffort }, "dsh reasoning effort rejected");
      });
    }
    const actualModel = modelValue ? normalizeDshModelId(modelValue) : (params.model || "dsh 默认");

    yield { kind: "init", sessionId, cwd: params.cwd, model: actualModel };

    // Updates must be wired BEFORE the prompt: ACP pushes live and never replays,
    // so a bridge attached late would silently drop the opening rounds.
    const pending: DriverEvent[] = [];
    let wake: (() => void) | undefined;
    unsub = client.onUpdate(sessionId, (u) => {
      const mapped = mapDshUpdate(u, state);
      if (mapped.length) {
        pending.push(...mapped);
        wake?.();
      }
    });

    // config.dsh.autoApprove=false with no interactive handler would park the
    // turn forever (dsh fails closed on an unanswered prompt), so the bot layer
    // only forwards a handler it can actually answer; the driver's headless
    // default (auto-approve) covers every other case.
    dropPermission = client.registerPermissionHandler(sessionId, buildPermissionHandler(state, params));

    yield { kind: "status", status: "running" };

    let stopReason: string | undefined;
    let promptError: Error | undefined;
    void client
      .prompt(sessionId, promptText, abortController.signal)
      .then((r) => {
        stopReason = r.stopReason ?? "end_turn";
      })
      .catch((err: unknown) => {
        promptError = err instanceof Error ? err : new Error(String(err));
      })
      .finally(() => wake?.());

    // Drain updates as they land until the turn settles. `stopReason === undefined`
    // means the response has not arrived yet (an empty string is a valid reason).
    while (true) {
      while (pending.length > 0) yield pending.shift()!;
      if (promptError || stopReason !== undefined) break;
      await new Promise<void>((resolve) => {
        wake = () => {
          wake = undefined;
          resolve();
        };
      });
    }
    // One settled drain: updates committed alongside the response can land after it.
    if (stopReason !== undefined) {
      await new Promise((r) => setTimeout(r, 80));
      while (pending.length > 0) yield pending.shift()!;
    }

    if (promptError) {
      yield { kind: "error", message: formatDshError(promptError.message) };
    } else {
      const cancelled = stopReason === "cancelled";
      const usage = await readLastTurnUsage(sessionId);
      yield {
        kind: "done",
        text: dshFinalText(state),
        isError: !cancelled && (stopReason === "refusal" || stopReason === "max_tokens"),
        aborted: cancelled,
        abortedReason: cancelled ? (timedOut ? "timeout" : "user") : undefined,
        contextUsagePct: dshContextUsagePct(state),
        usage,
      };
    }
  } catch (err) {
    const message = formatDshError(err instanceof Error ? err.message : String(err));
    logger.error({ err: String(err), sessionId }, "dsh run failed");
    yield { kind: "error", message };
  } finally {
    clearWatchdog();
    unsub?.();
    dropPermission?.();
  }
}

async function openOrResume(client: DshAcpClient, resume: string | undefined, cwd: string) {
  return resume ? client.resumeSession(resume, cwd) : client.newSession(cwd);
}

/**
 * Wire the ACP permission prompt for one session.
 *
 * Headless default: auto-approve (AGENTS.md §5.5) so an unattended cron/task can
 * never park on a permission prompt. With an interactive handler installed, the
 * request is routed through the bot's approval bridge (Telegram buttons) and the
 * chosen ACP option id is echoed back.
 */
export function buildPermissionHandler(state: RunState, params: RunParams): PermissionHandler {
  return async (req) => {
    const options = req.options ?? [];
    const allowOnce = options.find((o) => o.kind === "allow_once" || o.optionId === "allow-once");
    const rejectOnce = options.find((o) => o.kind === "reject_once" || o.optionId === "reject-once");
    const allowId = allowOnce?.optionId ?? "allow-once";
    const rejectId = rejectOnce?.optionId ?? "reject-once";
    if (!params.canUseToolHandler) return { outcome: { outcome: "selected", optionId: allowId } };
    const callId = req.toolCall?.toolCallId ?? "";
    const toolName = state.toolNames.get(callId) ?? req.toolCall?.title ?? "tool";
    try {
      const dec = await params.canUseToolHandler(
        {
          requestId: `${req.sessionId ?? "session"}:${callId || "unknown"}`,
          toolUseID: callId,
          toolName,
          input: {},
          description: req.reason,
          cwd: params.cwd,
        },
        new AbortController().signal,
      );
      return { outcome: { outcome: "selected", optionId: dec.behavior === "allow" ? allowId : rejectId } };
    } catch {
      // Fail closed: never leave the runtime parked on an unanswered prompt.
      return { outcome: { outcome: "selected", optionId: rejectId } };
    }
  };
}

/** Cheap availability probe for /engine and the admin panel.
 *
 *  An explicit path is used verbatim (a wrong explicit path is a misconfiguration
 *  worth surfacing) instead of silently falling through to the PATH lookup — the
 *  run path does fall back, so a typo would otherwise look like "dsh works" right
 *  up until something else silently ran. */
export function probeDshExecutable(customPath?: string): Promise<boolean> {
  const exe = customPath && customPath.trim() ? customPath : resolveDshExecutable();
  if (customPath && customPath.trim() && !existsSync(customPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(exe, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(false);
      }, 5000);
      timer.unref?.();
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}
