import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import type { DriverEvent, RunParams } from "../claude/types.js";
import type { OpenCodeEvent } from "./types.js";
import { logger } from "../util/logger.js";

/** Pure decision for "round" (agentic-turn) boundaries. */
export function shouldStartRound(
  state: { roundActive: boolean; pendingNewRound: boolean },
  trigger: "text" | "thinking" | "tool",
): { start: boolean; roundActive: boolean; pendingNewRound: boolean } {
  if (trigger === "tool") {
    return { start: false, roundActive: false, pendingNewRound: true };
  }
  if (!state.roundActive && (state.pendingNewRound || !state.roundActive)) {
    return { start: true, roundActive: true, pendingNewRound: false };
  }
  return { start: false, roundActive: state.roundActive, pendingNewRound: state.pendingNewRound };
}

/** Summarize tool input for live output display. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input.slice(0, 100);
  if (typeof input !== "object") return String(input);
  const obj = input as Record<string, unknown>;
  if (obj.command && typeof obj.command === "string") return obj.command.slice(0, 100);
  if (obj.path && typeof obj.path === "string") return obj.path;
  if (obj.file_path && typeof obj.file_path === "string") return obj.file_path;
  if (obj.query && typeof obj.query === "string") return obj.query.slice(0, 100);
  if (obj.pattern && typeof obj.pattern === "string") return obj.pattern.slice(0, 100);
  try {
    const s = JSON.stringify(obj);
    return s.length > 80 ? s.slice(0, 77) + "…" : s;
  } catch {
    return "";
  }
}

/**
 * Resolve OpenCode executable path.
 */
export function resolveOpenCodeExecutable(customPath?: string): string {
  if (customPath && existsSync(customPath)) return customPath;
  if (process.env.OPENCODE_PATH && existsSync(process.env.OPENCODE_PATH)) return process.env.OPENCODE_PATH;
  const commonPaths = [
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const p of commonPaths) {
    if (existsSync(p)) return p;
  }
  return "opencode";
}

/**
 * Drive OpenCode CLI using `opencode run [message] --format json` in a child process,
 * yielding high-level DriverEvents for Telegram streaming.
 */
export async function* runOpenCode(params: RunParams): AsyncGenerator<DriverEvent> {
  const abortController = new AbortController();
  let timedOut = false;

  if (params.signal) {
    if (params.signal.aborted) abortController.abort();
    else params.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  if (params.timeoutMs) {
    watchdog = setTimeout(() => {
      timedOut = true;
      logger.warn({ timeoutMs: params.timeoutMs }, "opencode task timed out, aborting");
      abortController.abort(new Error("task timed out"));
    }, params.timeoutMs);
  }

  const clear = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = undefined;
  };

  const executable = resolveOpenCodeExecutable(params.opencodePath);
  const promptText = params.prompt.text;

  const args: string[] = ["run", promptText, "--format", "json", "--dir", params.cwd];
  if (params.resume) {
    args.push("-s", params.resume);
  }
  if (params.model) {
    args.push("-m", params.model);
  }
  if (params.agent) {
    args.push("--agent", params.agent);
  }
  if (params.opencodeAutoApprove !== false) {
    args.push("--auto");
  }

  logger.info({ executable, cwd: params.cwd, resume: params.resume, model: params.model }, "spawning opencode run");

  let child: ChildProcess | undefined;
  let done = false;
  let roundActive = false;
  let pendingNewRound = true;
  let fullText = "";
  // Whether the CLI produced any stdout events at all. opencode reports some
  // failures (e.g. "Session not found" on a stale -s id) purely on stderr and
  // may exit 0 — without this flag that would surface as a silent empty done.
  let sawEvent = false;
  let stderrTail = "";
  // Real session id, captured from the events (opencode puts sessionID on every
  // line). Never synthesized: if no event carries one, no init is emitted and
  // the binding keeps its previous value instead of a fake id that would break
  // `-s` resume.
  let sessionId = params.resume || "";
  // Session id already announced via an init event (dedupes the per-event
  // sessionID sightings into exactly one init per id).
  let initSessionId: string | undefined;
  let costUsd: number | undefined;
  let durationMs: number | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  const toolNames = new Map<string, string>();
  const parseCtx = {
    sessionId,
    roundActive,
    pendingNewRound,
    toolNames,
    lastRoundText: "",
    emittedToolParts: new Set<string>(),
    emittedToolResults: new Set<string>(),
  };

  // Async queue to stream events from child process
  type QueueItem = { event: DriverEvent } | { error: Error } | { end: true };
  const queue: QueueItem[] = [];
  let notify: (() => void) | null = null;

  const push = (item: QueueItem) => {
    queue.push(item);
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };

  try {
    child = spawn(executable, args, {
      cwd: params.cwd,
      env: {
        ...process.env,
        // Disable interactive color output if any
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killChild = () => {
      if (!child || child.killed) return;
      try {
        child.kill("SIGINT");
        setTimeout(() => {
          if (child && !child.killed) {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        }, 2000).unref();
      } catch {}
    };

    abortController.signal.addEventListener("abort", () => {
      killChild();
    }, { once: true });

    if (abortController.signal.aborted) {
      killChild();
    }

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        sawEvent = true;

        let parsed: OpenCodeEvent;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // If non-JSON text output (e.g. plain text response), stream it as text
          if (trimmed) {
            const r = shouldStartRound({ roundActive, pendingNewRound }, "text");
            if (r.start) push({ event: { kind: "roundStart" } });
            roundActive = r.roundActive;
            pendingNewRound = r.pendingNewRound;
            fullText += trimmed + "\n";
            push({ event: { kind: "text", delta: trimmed + "\n" } });
          }
          return;
        }

        const events = parseOpenCodeJsonEvent(parsed, parseCtx);

        roundActive = events.roundActive;
        pendingNewRound = events.pendingNewRound;
        if (events.sessionId && events.sessionId !== sessionId) {
          sessionId = events.sessionId;
          parseCtx.sessionId = sessionId;
        }
        // Exactly one init per distinct session id, and only from REAL ids
        // carried by the events (never a synthesized placeholder).
        if (sessionId && sessionId !== initSessionId) {
          initSessionId = sessionId;
          push({
            event: {
              kind: "init",
              sessionId,
              cwd: params.cwd,
              model: params.model || "opencode",
            },
          });
        }
        if (events.costUsd !== undefined) costUsd = events.costUsd;
        if (events.durationMs !== undefined) durationMs = events.durationMs;
        if (events.usage) usage = events.usage;
        if (events.deltaText) fullText += events.deltaText;
        if (events.isDone) done = true;

        for (const ev of events.driverEvents) {
          push({ event: ev });
        }
      });
    }

    if (child.stderr) {
      const rlErr = createInterface({ input: child.stderr, crlfDelay: Infinity });
      rlErr.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed) {
          stderrTail = `${stderrTail}${stderrTail ? "\n" : ""}${trimmed}`.slice(-400);
          logger.debug({ opencodeStderr: trimmed }, "opencode stderr");
        }
      });
    }

    child.on("error", (err) => {
      logger.error({ err }, "opencode process error");
      push({ error: err });
    });

    child.on("close", (code, signal) => {
      clear();
      if (!done) {
        done = true;
        const wasAborted = abortController.signal.aborted || signal === "SIGINT" || signal === "SIGKILL";
        if (wasAborted) {
          push({
            event: {
              kind: "done",
              text: "",
              isError: false,
              aborted: true,
              abortedReason: timedOut ? "timeout" : "user",
            },
          });
        } else if (code !== 0 && code !== null) {
          push({
            event: {
              kind: "error",
              message: `OpenCode exited with status ${code}${stderrTail ? `: ${stderrTail.split("\n").pop()}` : ""}`,
            },
          });
        } else if (!sawEvent) {
          // Exit 0 (or killed without signal info) but the CLI never said
          // anything — e.g. "Session not found" printed to stderr. Surface it
          // instead of emitting a silent empty done.
          push({
            event: {
              kind: "error",
              message: `OpenCode produced no output${stderrTail ? `: ${stderrTail.split("\n").pop()}` : ""}`,
            },
          });
        } else {
          push({
            event: {
              kind: "done",
              text: fullText,
              isError: false,
              aborted: false,
              costUsd,
              durationMs,
              usage,
            },
          });
        }
      }
      push({ end: true });
    });

    // Yield events asynchronously
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      while (queue.length > 0) {
        const item = queue.shift()!;
        if ("end" in item) {
          return;
        }
        if ("error" in item) {
          if (!done) {
            yield { kind: "error", message: item.error.message };
          }
          return;
        }
        yield item.event;
      }
    }
  } finally {
    clear();
    if (child && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}

interface ParseContext {
  sessionId: string;
  roundActive: boolean;
  pendingNewRound: boolean;
  toolNames: Map<string, string>;
  /** Text accumulated for the current assistant round. Reset whenever a tool
   *  part is seen; when the run stops, this is the final answer. */
  lastRoundText: string;
  /** First/last event timestamps, for the wall-clock duration at done. */
  firstTimestamp?: number;
  lastTimestamp?: number;
  /** part ids whose tool event / tool result we already emitted — opencode may
   *  stream the same part several times (pending → completed). */
  emittedToolParts: Set<string>;
  emittedToolResults: Set<string>;
}

interface ParseResult {
  driverEvents: DriverEvent[];
  roundActive: boolean;
  pendingNewRound: boolean;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  usage?: { inputTokens: number; outputTokens: number };
  deltaText?: string;
  isDone?: boolean;
}

/**
 * Parse one OpenCode JSON event object and map to standard DriverEvents.
 *
 * Real `opencode run --format json` line shape (one event per line):
 *   {"type":"step_start",  "timestamp":…, "sessionID":"ses_…", "part":{"type":"step-start",…}}
 *   {"type":"text",        "timestamp":…, "sessionID":"ses_…", "part":{"type":"text","text":"…",…}}
 *   {"type":"reasoning",   …              "part":{"type":"reasoning","text":"…",…}}
 *   {"type":"tool_use",    …              "part":{"type":"tool","tool":"bash","callID":"call_…",
 *                                                "state":{"status":"completed","input":{…},
 *                                                         "output":"…","title":"ls",…}}}
 *   {"type":"step_finish", …              "part":{"type":"step-finish","reason":"stop"|"tool-calls",
 *                                                "tokens":{"input":…,"output":…,"reasoning":…},
 *                                                "cost":…}}
 *
 * `sessionID` rides on every event; the DRIVER emits the single init when it
 * first appears (the parser never emits init itself, so a session id can never
 * be synthesized). Legacy/alternate shapes (bare `tool_call`, `tool_result`,
 * `result`) are still tolerated for older CLI versions.
 */
export function parseOpenCodeJsonEvent(
  obj: OpenCodeEvent,
  ctx: ParseContext,
): ParseResult {
  const driverEvents: DriverEvent[] = [];
  let roundActive = ctx.roundActive;
  let pendingNewRound = ctx.pendingNewRound;
  let sessionId = ctx.sessionId;
  let costUsd: number | undefined;
  let durationMs: number | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let deltaText = "";
  let isDone = false;

  const o = obj as Record<string, any>;
  const part = (o.part && typeof o.part === "object" ? o.part : {}) as Record<string, any>;
  const type = String(o.type || o.event || "").toLowerCase();
  const partType = String(part.type ?? "").toLowerCase();
  if (typeof o.timestamp === "number") {
    if (ctx.firstTimestamp === undefined) ctx.firstTimestamp = o.timestamp;
    ctx.lastTimestamp = o.timestamp;
  }

  // 0. Real session id — present on every opencode event (top-level and/or in
  //    the part). The driver turns the first sighting into the single init.
  const sid = o.sessionID || o.sessionId || o.session_id || part.sessionID;
  if (sid) sessionId = String(sid);

  // 1. Text Content Delta
  let textDelta: string | undefined;
  if (type === "text" || partType === "text" || type === "content_block_delta" || type === "delta" || type === "content" || type === "message") {
    if (typeof part.text === "string") textDelta = part.text;
    else if (typeof o.text === "string") textDelta = o.text;
    else if (typeof o.delta === "string") textDelta = o.delta;
    else if (o.delta?.text) textDelta = o.delta.text;
    else if (typeof o.content === "string") textDelta = o.content;
  }

  if (textDelta) {
    const r = shouldStartRound({ roundActive, pendingNewRound }, "text");
    if (r.start) driverEvents.push({ kind: "roundStart" });
    roundActive = r.roundActive;
    pendingNewRound = r.pendingNewRound;
    ctx.lastRoundText += textDelta;
    deltaText += textDelta;
    driverEvents.push({ kind: "text", delta: textDelta });
  }

  // 2. Thinking / Reasoning Delta
  let thinkingDelta: string | undefined;
  if (type === "reasoning" || partType === "reasoning" || type === "thinking" || type === "thought") {
    if (typeof part.text === "string") thinkingDelta = part.text;
    else if (typeof part.reasoning === "string") thinkingDelta = part.reasoning;
    else if (typeof o.text === "string") thinkingDelta = o.text;
    else if (typeof o.delta === "string") thinkingDelta = o.delta;
    else if (o.delta?.reasoning) thinkingDelta = o.delta.reasoning;
  }

  if (thinkingDelta) {
    const r = shouldStartRound({ roundActive, pendingNewRound }, "thinking");
    if (r.start) driverEvents.push({ kind: "roundStart" });
    roundActive = r.roundActive;
    pendingNewRound = r.pendingNewRound;
    driverEvents.push({ kind: "thinking", delta: thinkingDelta });
  }

  // 3. Tool Call (+ embedded result). OpenCode delivers a tool part carrying
  //    name/callID and a `state` that holds input, and once finished also the
  //    output — the same part id may arrive more than once (pending first).
  if (type === "tool_use" || type === "tool_call" || type === "tool" || partType === "tool") {
    const name = String(part.tool || part.name || o.tool || o.name || o.toolName || "tool");
    const toolId = String(part.callID || o.tool_use_id || o.call_id || o.id || part.id || "");
    if (toolId) ctx.toolNames.set(toolId, name);
    const state = (part.state && typeof part.state === "object" ? part.state : {}) as Record<string, any>;
    const input = state.input ?? part.input ?? o.input ?? o.args ?? {};
    const summary = summarizeToolInput(name, input) || (typeof state.title === "string" ? state.title : "");

    // A tool boundary closes the current text round (the next text part starts
    // the next round's answer).
    ctx.lastRoundText = "";

    if (!toolId || !ctx.emittedToolParts.has(toolId)) {
      if (toolId) ctx.emittedToolParts.add(toolId);
      const r = shouldStartRound({ roundActive, pendingNewRound }, "tool");
      roundActive = r.roundActive;
      pendingNewRound = r.pendingNewRound;
      driverEvents.push({ kind: "tool", name, summary });
    }

    if (state.output !== undefined && (!toolId || !ctx.emittedToolResults.has(toolId))) {
      if (toolId) ctx.emittedToolResults.add(toolId);
      const rawContent = state.output ?? part.output ?? o.output ?? o.content ?? "";
      const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
      const isError = state.status === "error" || Boolean(o.is_error || o.isError);
      driverEvents.push({ kind: "toolResult", name, content: content || "(ok)", isError });
    }
  }

  // 4. Standalone Tool Result Event (legacy shape)
  if (type === "tool_result" || type === "tool_output") {
    const toolId = o.tool_use_id || o.id;
    const name = (toolId ? ctx.toolNames.get(toolId) : undefined) || o.name || o.tool || "tool";
    const rawContent = o.output ?? o.content ?? o.result ?? "";
    const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
    const isError = Boolean(o.is_error || o.isError);
    driverEvents.push({ kind: "toolResult", name, content: content || "(ok)", isError });
  }

  // 5. Step Finish / Result. `reason:"stop"` marks the true end of the run
  //    ("tool-calls" just closes an intermediate step around tool calls). The
  //    final answer is the text accumulated since the last tool boundary.
  if (type === "step_finish" || partType === "step-finish" || type === "result" || type === "done" || type === "finish" || type === "complete") {
    const tokens = (part.tokens && typeof part.tokens === "object" ? part.tokens : undefined)
      ?? (o.tokens && typeof o.tokens === "object" ? o.tokens : undefined)
      ?? (o.usage && typeof o.usage === "object" ? o.usage : undefined);
    if (tokens) {
      const inTok = tokens.input ?? tokens.input_tokens ?? tokens.inputTokens ?? 0;
      const outTok = (tokens.output ?? tokens.output_tokens ?? tokens.outputTokens ?? 0) + (tokens.reasoning ?? 0);
      usage = { inputTokens: inTok, outputTokens: outTok };
    }
    costUsd = part.cost ?? o.total_cost_usd ?? o.cost;

    const reason = String(part.reason ?? o.reason ?? "");
    const finalStop = reason === "stop" || type === "result" || type === "done" || type === "complete" || type === "finish";
    if (finalStop) {
      isDone = true;
      if (ctx.firstTimestamp !== undefined && ctx.lastTimestamp !== undefined && ctx.lastTimestamp >= ctx.firstTimestamp) {
        durationMs = ctx.lastTimestamp - ctx.firstTimestamp;
      } else {
        durationMs = o.duration_ms ?? o.durationMs;
      }
      const isError = Boolean(o.is_error || o.isError);
      const resultText = o.result ?? o.text ?? ctx.lastRoundText;
      driverEvents.push({
        kind: "done",
        text: resultText,
        isError,
        aborted: false,
        costUsd,
        durationMs,
        usage,
      });
    }
  }

  // 6. Error Event
  if (type === "error" || type === "session_error") {
    const raw = o.message || o.error?.message || o.error || part.error || "OpenCode error";
    const msg = typeof raw === "string" ? raw : JSON.stringify(raw);
    driverEvents.push({ kind: "error", message: msg });
  }

  return {
    driverEvents,
    roundActive,
    pendingNewRound,
    sessionId,
    costUsd,
    durationMs,
    usage,
    deltaText,
    isDone,
  };
}
