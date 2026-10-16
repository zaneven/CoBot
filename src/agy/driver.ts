import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import type { DriverEvent, RunParams } from "../claude/types.js";
import type { AGyEvent } from "./types.js";
import { logger } from "../util/logger.js";
import { shouldStartRound, summarizeToolInput } from "../opencode/driver.js";

/**
 * Resolve Antigravity executable path.
 */
export function resolveAGyExecutable(customPath?: string): string {
  if (customPath && existsSync(customPath)) return customPath;
  if (process.env.AGY_PATH && existsSync(process.env.AGY_PATH)) return process.env.AGY_PATH;
  const commonPaths = [
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    "/usr/bin/agy",
  ];
  for (const p of commonPaths) {
    if (existsSync(p)) return p;
  }
  return "agy";
}

/**
 * Strip AGy internal protocol injection tags, system message wrappers, and
 * background task completion logs from full strings or terminal result responses.
 */
export function sanitizeAGyText(text: string): string {
  if (!text) return "";
  let clean = text;

  // 1. Closed <SYSTEM_MESSAGE> ... </SYSTEM_MESSAGE>} blocks (including trailing '}')
  clean = clean.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>}?/gi, "");

  // 2. Unclosed or missing open-tag task finish notices:
  //    [Message] timestamp=... content=Task id "..." finished with result:...
  clean = clean.replace(
    /\[Message\]\s+timestamp=[\s\S]*?content=Task id\s+["'][^"']+["']\s+finished with result:[\s\S]*?(?:(?:Task output has been logged to:|Log:)[^\n]*(?:\n|<\/SYSTEM_MESSAGE>}?)?)/gi,
    "",
  );

  // 3. Any leftover [Message] block terminated by </SYSTEM_MESSAGE>}
  clean = clean.replace(/\[Message\]\s+timestamp=[\s\S]*?<\/SYSTEM_MESSAGE>}?/gi, "");

  // 4. Trailing unclosed <SYSTEM_MESSAGE> tag and everything after it
  clean = clean.replace(/<SYSTEM_MESSAGE>[\s\S]*$/gi, "");

  // 5. Stray orphan tags or brackets
  clean = clean.replace(/<\/?SYSTEM_MESSAGE>}?/gi, "");

  // 6. Tidy multiple blank lines and trailing spaces
  return clean.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Streaming sanitizer that hides AGy internal protocol messages from the live token stream.
 */
export class AGyStreamSanitizer {
  private buffer = "";
  private inSystemBlock = false;

  private static readonly OPEN_TAG = "<SYSTEM_MESSAGE>";
  private static readonly CLOSE_TAG = "</SYSTEM_MESSAGE>";
  private static readonly MSG_PREFIX = "[Message] timestamp=";

  /**
   * Feed a new text chunk and return only the display-safe portion.
   */
  feed(chunk: string): string {
    if (!chunk) return "";
    this.buffer += chunk;
    let safeOutput = "";

    while (this.buffer.length > 0) {
      if (this.inSystemBlock) {
        // Look for closing tag </SYSTEM_MESSAGE>
        const closeIdx = this.buffer.toUpperCase().indexOf(AGyStreamSanitizer.CLOSE_TAG);
        if (closeIdx >= 0) {
          let endIdx = closeIdx + AGyStreamSanitizer.CLOSE_TAG.length;
          if (this.buffer[endIdx] === "}") {
            endIdx++;
          }
          this.buffer = this.buffer.slice(endIdx);
          this.inSystemBlock = false;
          continue;
        }

        // Look for log finish marker
        const logEndMatch = /(?:Task output has been logged to:|Log:)[^\n]*\n/i.exec(this.buffer);
        if (logEndMatch && logEndMatch.index !== undefined) {
          let endIdx = logEndMatch.index + logEndMatch[0].length;
          const rest = this.buffer.slice(endIdx);
          const followClose = /^<\/?SYSTEM_MESSAGE>}?/i.exec(rest);
          if (followClose) {
            endIdx += followClose[0].length;
          }
          this.buffer = this.buffer.slice(endIdx);
          this.inSystemBlock = false;
          continue;
        }

        // Still in system block; preserve potential partial close tag at tail
        const tailCheckLen = AGyStreamSanitizer.CLOSE_TAG.length;
        let keepLen = 0;
        for (let i = 1; i < tailCheckLen && i <= this.buffer.length; i++) {
          const tail = this.buffer.slice(this.buffer.length - i).toUpperCase();
          if (AGyStreamSanitizer.CLOSE_TAG.startsWith(tail)) {
            keepLen = i;
          }
        }
        this.buffer = this.buffer.slice(this.buffer.length - keepLen);
        break;
      } else {
        // Not in system block; check for opening markers
        const upper = this.buffer.toUpperCase();
        const openIdx = upper.indexOf(AGyStreamSanitizer.OPEN_TAG);
        const msgIdx = this.buffer.indexOf(AGyStreamSanitizer.MSG_PREFIX);

        let targetIdx = -1;
        let skipLen = 0;
        if (openIdx >= 0 && msgIdx >= 0) {
          if (openIdx <= msgIdx) {
            targetIdx = openIdx;
            skipLen = AGyStreamSanitizer.OPEN_TAG.length;
          } else {
            targetIdx = msgIdx;
            skipLen = 0;
          }
        } else if (openIdx >= 0) {
          targetIdx = openIdx;
          skipLen = AGyStreamSanitizer.OPEN_TAG.length;
        } else if (msgIdx >= 0) {
          targetIdx = msgIdx;
          skipLen = 0;
        }

        if (targetIdx >= 0) {
          safeOutput += this.buffer.slice(0, targetIdx);
          this.buffer = this.buffer.slice(targetIdx + skipLen);
          this.inSystemBlock = true;
          continue;
        }

        // Neither found; check for partial prefix of open tag or message prefix at the buffer tail
        const maxCheck = Math.max(AGyStreamSanitizer.OPEN_TAG.length, AGyStreamSanitizer.MSG_PREFIX.length);
        let keepLen = 0;
        for (let i = 1; i < maxCheck && i <= this.buffer.length; i++) {
          const tail = this.buffer.slice(this.buffer.length - i);
          const tailUpper = tail.toUpperCase();
          if (
            AGyStreamSanitizer.OPEN_TAG.startsWith(tailUpper) ||
            AGyStreamSanitizer.MSG_PREFIX.startsWith(tail)
          ) {
            keepLen = i;
          }
        }

        const emitLen = this.buffer.length - keepLen;
        if (emitLen > 0) {
          safeOutput += this.buffer.slice(0, emitLen);
          this.buffer = this.buffer.slice(emitLen);
        }
        break;
      }
    }

    return safeOutput;
  }

  /**
   * Flush any remaining buffered characters.
   */
  flush(): string {
    if (this.inSystemBlock) {
      this.buffer = "";
      return "";
    }
    const remaining = this.buffer;
    this.buffer = "";
    return sanitizeAGyText(remaining);
  }
}

export interface ParseContext {
  sessionId: string;
  roundActive: boolean;
  pendingNewRound: boolean;
  lastRoundText: string;
  emittedToolParts: Set<number>;
  emittedToolResults: Set<number>;
  sanitizer?: AGyStreamSanitizer;
}

interface ParseResult {
  driverEvents: DriverEvent[];
  roundActive: boolean;
  pendingNewRound: boolean;
  sessionId?: string;
  deltaText?: string;
  isDone?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  durationMs?: number;
}

/**
 * Convert a wall-clock seconds value into milliseconds.
 */
function secToMs(sec?: number | null): number | undefined {
  if (typeof sec === "number" && Number.isFinite(sec)) return sec * 1000;
  return undefined;
}

/**
 * Parse one AGy JSON event object and map to standard DriverEvents.
 */
export function parseAGyEvent(
  obj: AGyEvent,
  ctx: ParseContext,
): ParseResult {
  const driverEvents: DriverEvent[] = [];
  let roundActive = ctx.roundActive;
  let pendingNewRound = ctx.pendingNewRound;
  let sessionId = ctx.sessionId;
  let deltaText = "";
  let isDone = false;
  let usage: ParseResult["usage"];
  let durationMs: ParseResult["durationMs"];

  const o = obj as Record<string, unknown>;
  const event = String(o.event || "").toLowerCase();
  const stepObj = (o.step_update || o.stepUpdate) as Record<string, unknown> | undefined;
  const resObj = (o.result) as Record<string, unknown> | undefined;

  const rawConvId = o.conversation_id ?? o.conversationId ?? stepObj?.conversation_id ?? stepObj?.conversationId ?? resObj?.conversation_id ?? resObj?.conversationId;
  if (typeof rawConvId === "string" && rawConvId) {
    sessionId = rawConvId;
  }
  if (sessionId && sessionId !== ctx.sessionId) {
    ctx.sessionId = sessionId;
  }

  // 1. Init event — its conversation_id is captured at the top of the parser;
  //    the driver emits the single init DriverEvent (so cwd/model come from
  //    RunParams and the id can never be synthesized in the parser).
  if (event === "init") {
    // no-op here; conversation_id already propagated into sessionId above
  }

  // 2. Step update events — the meat of the stream
  if (event === "step_update") {
    const step = (o.step_update && typeof o.step_update === "object"
      ? o.step_update
      : o.stepUpdate && typeof o.stepUpdate === "object"
        ? o.stepUpdate
        : {}) as Record<string, unknown>;

    const stepIndex =
      typeof step.step_index === "number" ? step.step_index
        : typeof step.stepIndex === "number" ? step.stepIndex
          : -1;
    const state = String(step.state || "").toUpperCase();
    const stepType = String(
      step.step_type || step.stepType || "",
    ).toLowerCase();

    // Gather usage / duration whenever any step update carries them
    if (step.usage && typeof step.usage === "object") {
      const u = step.usage as Record<string, unknown>;
      const inTok = Number(u.input_tokens ?? u.inputTokens ?? 0) || 0;
      const outTok =
        (Number(u.output_tokens ?? u.outputTokens ?? 0) || 0) +
        (Number(u.thinking_tokens ?? u.thinkingTokens ?? 0) || 0);
      if (inTok || outTok) usage = { inputTokens: inTok, outputTokens: outTok };
    }
    if (typeof step.duration_seconds === "number" || typeof step.durationSeconds === "number") {
      durationMs = secToMs(Number(step.duration_seconds ?? step.durationSeconds));
    }

    // 2a. user_input — echo of the user's prompt; skip.
    if (stepType === "user_input") {
      return {
        driverEvents,
        roundActive,
        pendingNewRound,
        sessionId,
        deltaText,
        usage,
        durationMs,
        isDone,
      };
    }

    // 2b. thinking — defensive; some agy runs stream reasoning as its own step.
    if (stepType === "thinking") {
      const td = typeof step.text_delta === "string"
        ? step.text_delta
        : typeof step.textDelta === "string"
          ? step.textDelta
          : "";
      if (td) {
        const r = shouldStartRound({ roundActive, pendingNewRound }, "thinking");
        if (r.start) driverEvents.push({ kind: "roundStart" });
        roundActive = r.roundActive;
        pendingNewRound = r.pendingNewRound;
        driverEvents.push({ kind: "thinking", delta: td });
      }
      return {
        driverEvents,
        roundActive,
        pendingNewRound,
        sessionId,
        deltaText,
        usage,
        durationMs,
        isDone,
      };
    }

    // 2c. tool — ACTIVE = invoked, DONE = finished, ERROR = tool error
    if (stepType === "tool") {
      const toolInfo = (step.tool_info ?? step.toolInfo) as Record<string, unknown> | undefined;
      const name = String(
        step.tool_name ?? step.toolName ??
          (toolInfo?.name ?? "tool"),
      );
      if (state === "ACTIVE") {
        if (ctx.sanitizer) {
          const flushed = ctx.sanitizer.flush();
          if (flushed) {
            ctx.lastRoundText += flushed;
            deltaText += flushed;
            driverEvents.push({ kind: "text", delta: flushed });
          }
        }
        const input = toolInfo && typeof toolInfo === "object" ? ((toolInfo.parameters as Record<string, unknown>) ?? {}) : {};
        const summary = summarizeToolInput(name, input) || name;
        if (!ctx.emittedToolParts.has(stepIndex)) {
          ctx.emittedToolParts.add(stepIndex);
          ctx.lastRoundText = "";
          const r = shouldStartRound({ roundActive, pendingNewRound }, "tool");
          roundActive = r.roundActive;
          pendingNewRound = r.pendingNewRound;
          driverEvents.push({ kind: "tool", name, summary });
        }
      }
      if ((state === "DONE" || state === "ERROR") && !ctx.emittedToolResults.has(stepIndex)) {
        ctx.emittedToolResults.add(stepIndex);
        const isError = state === "ERROR";
        let content = "(completed)";
        if (isError) {
          const errObj = toolInfo?.error;
          content = typeof errObj === "string"
            ? errObj
            : ((errObj as { message?: string })?.message || "(error)");
        } else if (typeof toolInfo?.output === "string") {
          content = toolInfo.output;
        }
        driverEvents.push({ kind: "toolResult", name, content, isError });
      }
      return {
        driverEvents,
        roundActive,
        pendingNewRound,
        sessionId,
        deltaText,
        usage,
        durationMs,
        isDone,
      };
    }

    // 2d. agent_response — streamed text chunks; the final answer lives here.
    if (stepType === "agent_response") {
      const rawTd = typeof step.text_delta === "string"
        ? step.text_delta
        : typeof step.textDelta === "string"
          ? step.textDelta
          : "";
      if (rawTd) {
        if (!ctx.sanitizer) {
          ctx.sanitizer = new AGyStreamSanitizer();
        }
        const td = ctx.sanitizer.feed(rawTd);
        if (td) {
          const r = shouldStartRound({ roundActive, pendingNewRound }, "text");
          if (r.start) driverEvents.push({ kind: "roundStart" });
          roundActive = r.roundActive;
          pendingNewRound = r.pendingNewRound;
          ctx.lastRoundText += td;
          deltaText += td;
          driverEvents.push({ kind: "text", delta: td });
        }
      }
    }
  }

  // 3. Result event — terminal summary with final response, status, usage.
  if (event === "result") {
    if (ctx.sanitizer) {
      const flushed = ctx.sanitizer.flush();
      if (flushed) {
        ctx.lastRoundText += flushed;
        deltaText += flushed;
      }
    }
    const result = (typeof o.result === "object" && o.result ? o.result : {}) as Record<string, unknown>;
    const status = String(result.status || "").toUpperCase();
    const rawResultText = typeof result.response === "string" ? result.response : ctx.lastRoundText;
    const resultText = sanitizeAGyText(rawResultText);
    const isError = status === "ERROR";

    if (result.usage && typeof result.usage === "object") {
      const u = result.usage as Record<string, unknown>;
      const inTok = Number(u.input_tokens ?? u.inputTokens ?? 0) || 0;
      const outTok =
        (Number(u.output_tokens ?? u.outputTokens ?? 0) || 0) +
        (Number(u.thinking_tokens ?? u.thinkingTokens ?? 0) || 0);
      if (inTok || outTok) usage = { inputTokens: inTok, outputTokens: outTok };
    }
    if (typeof result.duration_seconds === "number" || typeof result.durationSeconds === "number") {
      durationMs = secToMs(Number(result.duration_seconds ?? result.durationSeconds));
    }

    isDone = true;
    driverEvents.push({
      kind: "done",
      text: resultText,
      isError,
      aborted: status === "ABORTED" || status === "CANCELLED",
      usage,
      durationMs,
    });
  }

  // 4. Error event
  if (event === "error") {
    const raw = typeof o.message === "string" ? o.message
      : o.error && typeof o.error === "object" ? (o.error as { message?: string }).message
        : "Antigravity error";
    isDone = true;
    driverEvents.push({ kind: "error", message: typeof raw === "string" ? raw : JSON.stringify(raw) });
  }

  return {
    driverEvents,
    roundActive,
    pendingNewRound,
    sessionId,
    deltaText,
    isDone,
    usage,
    durationMs,
  };
}

function msToGoDuration(timeoutMs: number): string {
  const sec = Math.ceil(timeoutMs / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s}s`;
}

/**
 * Drive Antigravity CLI using `agy --print <prompt> --output-format stream-json`
 * in a child process, yielding high-level DriverEvents for Telegram streaming.
 */
export async function* runAGy(params: RunParams): AsyncGenerator<DriverEvent> {
  const abortController = new AbortController();
  let timedOut = false;

  if (params.signal) {
    if (params.signal.aborted) abortController.abort();
    else params.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  if (params.timeoutMs && params.timeoutMs > 0) {
    watchdog = setTimeout(() => {
      timedOut = true;
      logger.warn({ timeoutMs: params.timeoutMs }, "agy task timed out, aborting");
      abortController.abort(new Error("task timed out"));
    }, params.timeoutMs);
  }

  const clear = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = undefined;
  };

  const executable = resolveAGyExecutable(params.agyPath);
  const promptText = params.prompt.text;

  const args: string[] = ["--print", promptText, "--output-format", "stream-json"];
  if (params.resume) {
    args.push("--conversation", params.resume);
  }
  if (params.model) {
    args.push("--model", params.model);
  }
  if (params.agent) {
    args.push("--agent", params.agent);
  }
  if (params.agyEffort) {
    args.push("--effort", params.agyEffort);
  }
  if (params.timeoutMs && params.timeoutMs > 0) {
    args.push("--print-timeout", msToGoDuration(params.timeoutMs));
  }
  // Auto-approve flag: omit only when the caller explicitly disables it.
  if (params.agyAutoApprove !== false) {
    args.push("--dangerously-skip-permissions");
  }
  for (const dir of params.additionalDirectories || []) {
    args.push("--add-dir", dir);
  }

  logger.info(
    { executable, cwd: params.cwd, resume: params.resume, model: params.model, agent: params.agent, effort: params.agyEffort },
    "spawning agy --print",
  );

  let child: ChildProcess | undefined;
  let done = false;
  let fullText = "";
  let sawEvent = false;
  let stderrTail = "";
  let sessionId = params.resume || "";
  let initSessionId: string | undefined;
  let costUsd: number | undefined;
  let durationMs: number | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;

  const parseCtx: ParseContext = {
    sessionId,
    roundActive: false,
    pendingNewRound: true,
    lastRoundText: "",
    emittedToolParts: new Set(),
    emittedToolResults: new Set(),
  };

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

        let parsed: AGyEvent;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // Non-JSON line (rare; agy stream-json should be well-formed) — log and skip.
          logger.debug({ agyLine: trimmed.slice(0, 200) }, "agy non-JSON line, skipping");
          return;
        }

        sawEvent = true;
        const events = parseAGyEvent(parsed, parseCtx);

        if (events.sessionId && events.sessionId !== sessionId) {
          sessionId = events.sessionId;
        }
        if (events.usage) usage = events.usage;
        if (events.durationMs !== undefined) durationMs = events.durationMs;
        if (events.deltaText) fullText += events.deltaText;
        if (events.isDone) done = true;

        // Exactly one init per distinct session id, and only from REAL ids
        // carried by the events (never synthesized).
        if (sessionId && sessionId !== initSessionId) {
          initSessionId = sessionId;
          push({
            event: {
              kind: "init",
              sessionId,
              cwd: params.cwd,
              model: params.model || "agy",
            },
          });
        }

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
          logger.debug({ agyStderr: trimmed }, "agy stderr");
        }
      });
    }

    child.on("error", (err) => {
      logger.error({ err }, "agy process error");
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
              text: sanitizeAGyText(fullText),
              isError: false,
              aborted: true,
              abortedReason: timedOut ? "timeout" : "user",
              usage,
              durationMs,
            },
          });
        } else if (code !== 0 && code !== null) {
          push({
            event: {
              kind: "error",
              message: `Antigravity exited with status ${code}${stderrTail ? `: ${stderrTail.split("\n").pop()}` : ""}`,
            },
          });
        } else if (!sawEvent) {
          push({
            event: {
              kind: "error",
              message: `Antigravity produced no output${stderrTail ? `: ${stderrTail.split("\n").pop()}` : ""}`,
            },
          });
        } else {
          push({
            event: {
              kind: "done",
              text: sanitizeAGyText(fullText),
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
