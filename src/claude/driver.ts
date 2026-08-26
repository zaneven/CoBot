import { existsSync } from "node:fs";
import { query, type Options, type SDKMessage, type SDKUserMessage, type ModelUsage, type PermissionResult, type PermissionUpdate, type UserDialogResult as SdkUserDialogResult } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { DriverEvent, RunParams, PromptInput, MediaAttachment, PermissionRequest, PermissionDecision, UserDialogRequest, UserDialogResult } from "./types.js";
import { logger } from "../util/logger.js";

/**
 * Drive a Claude Code conversation via the Claude Agent SDK, yielding high-level
 * {@link DriverEvent}s. Resumes an existing session when `resume` is set, else
 * starts a fresh one (the `init` event carries the new session id).
 */
export async function* runClaude(params: RunParams): AsyncGenerator<DriverEvent> {
  const abortController = new AbortController();
  if (params.signal) {
    if (params.signal.aborted) abortController.abort();
    else params.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }
  // Watchdog: abort if the turn exceeds the budget, so a headless task can never
  // hang indefinitely on an unanswered permission prompt or a frozen tool.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  if (params.timeoutMs) {
    watchdog = setTimeout(() => {
      timedOut = true;
      logger.warn({ timeoutMs: params.timeoutMs }, "claude task timed out, aborting");
      abortController.abort(new Error("task timed out"));
    }, params.timeoutMs);
  }
  let clear = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = undefined;
  };
  const onFinish = () => {
    clear();
  };

  const options: Options = { cwd: params.cwd, abortController };
  const claudeExecutable = params.claudePath ?? process.env.CLAUDE_PATH ?? (existsSync("/opt/homebrew/bin/claude") ? "/opt/homebrew/bin/claude" : undefined);
  if (claudeExecutable) {
    options.pathToClaudeCodeExecutable = claudeExecutable;
  }
  if (params.resume) options.resume = params.resume;
  if (params.model) options.model = params.model;
  if (params.permissionMode) options.permissionMode = params.permissionMode as Options["permissionMode"];
  if (params.allowDangerouslySkipPermissions) options.allowDangerouslySkipPermissions = true;
  if (params.allowedTools && params.allowedTools.length) options.allowedTools = params.allowedTools;
  if (params.additionalDirectories && params.additionalDirectories.length) options.additionalDirectories = params.additionalDirectories;
  if (params.maxTurns) options.maxTurns = params.maxTurns;
  // Stream partial assistant tokens so the bot can render output progressively.
  // Without this the SDK does NOT emit SDKPartialAssistantMessage (stream_event)
  // frames, so the chat sees nothing until the whole turn finishes - which reads
  // as "no results during execution" and, if the turn then hangs, as silence.
  options.includePartialMessages = true;

  // Tool-use permission: either delegate to an interactive handler (bot layer)
  // or headless auto-approve. bypassPermissions already skips every check, so
  // don't set canUseTool there — it'd be dead and risks an SDK config conflict.
  // NEVER return null from canUseTool: that sends no control_response and the
  // tool blocks forever (permission prompts have no park deadline).
  if (params.permissionMode !== "bypassPermissions") {
    if (params.canUseToolHandler) {
      const handler = params.canUseToolHandler;
      options.canUseTool = async (toolName, input, opts) => {
        const req = buildPermissionRequest(toolName, input, opts, params.cwd);
        const dec = await handler(req, opts.signal);
        // Thread the original input into the allow result (see toSdkPermissionResult):
        // the SDK's runtime Zod schema REQUIRES `updatedInput` (a record) on an
        // allow, so a bare {behavior:"allow"} fails validation and the tool is
        // rejected as a permission error before it ever runs.
        return toSdkPermissionResult(dec, input);
      };
    } else {
      options.canUseTool = async (toolName, input) => {
        logger.debug({ toolName }, "canUseTool: auto-approved");
        return { behavior: "allow" as const, updatedInput: input };
      };
    }
  }

  // User dialogs (e.g. AskUserQuestion): the model can ask the user a question
  // via the `request_user_dialog` control flow. The CLI only emits a dialog
  // kind declared in `supportedDialogKinds` AND only forwards it when
  // `onUserDialog` is set — omitting EITHER means the dialog is silently
  // auto-cancelled (the model gets no answer and proceeds with its default),
  // which was the "bot never asked the question, no options shown" bug. Wire
  // both together only when a handler is provided. For headless runs (cron,
  // no handler) leave unset so the SDK applies the dialog's default behavior.
  if (params.userDialogHandler) {
    const handler = params.userDialogHandler;
    options.supportedDialogKinds = ["ask_user_question"];
    options.onUserDialog = async (request, opts) => {
      const req = buildUserDialogRequest(request, opts.requestId);
      const res = await handler(req, opts.signal);
      return toSdkUserDialogResult(res);
    };
  }

  // Concatenation of every text delta we've already yielded (both the live
  // partial deltas from stream_event AND any tail we recovered from an
  // `assistant` snapshot), so each canonical assistant text block can be
  // diffed against what was already streamed — letting us recover any part the
  // partial deltas missed (e.g. the text AFTER a tool_use, which partials often
  // omit) WITHOUT ever re-emitting text we already sent.
  let streamedSoFar = "";
  let done = false;
  let timedOut = false;
  // Round tracking: one agentic turn = one "round" of thinking. Text/thinking
  // deltas arrive *before* the `assistant` message that closes the turn, so we
  // can't know a new round started until its first delta shows up. We open a
  // round on the first delta overall, and on the first delta *after* a tool-using
  // turn (signalled by `pendingNewRound`, set when a tool_use block is seen).
  let roundActive = false;
  let pendingNewRound = false;
  // tool_use_id -> tool name, so tool_result blocks can be labelled with the
  // tool that produced them.
  const toolNames = new Map<string, string>();

  try {
    const stream = query({ prompt: buildSdkPrompt(params.prompt), options });
    for await (const msg of stream as AsyncIterable<SDKMessage>) {
      switch (msg.type) {
        case "system": {
          const sys = msg as { subtype?: string; session_id?: string; cwd?: string; model?: string; status?: string | null };
          if (sys.subtype === "init" && sys.session_id) {
            yield { kind: "init", sessionId: sys.session_id, cwd: sys.cwd ?? params.cwd, model: sys.model ?? "" };
          } else if (sys.subtype === "status" && sys.status) {
            yield { kind: "status", status: sys.status };
          }
          break;
        }
        case "stream_event": {
          // Partial assistant content (token deltas). Emitted when the SDK streams.
          const ev = (msg as { event: { type: string; delta?: { type: string; text?: string; thinking?: string } } }).event;
          if (ev.type !== "content_block_delta" || !ev.delta) break;
          const mapped = mapContentBlockDelta(ev.delta);
          if (!mapped) break;
          // Open a new round on the first delta of a turn (overall, or after a
          // tool-using turn). This fires before the delta itself so the bot
          // layer can attach a fresh message header to the upcoming text.
          if (mapped.kind === "text" || mapped.kind === "thinking") {
            const r = shouldStartRound({ roundActive, pendingNewRound }, mapped.kind);
            if (r.start) yield { kind: "roundStart" };
            roundActive = r.roundActive;
            pendingNewRound = r.pendingNewRound;
          }
          if (mapped.kind === "text") streamedSoFar += mapped.delta;
          yield mapped;
          break;
        }
        case "assistant": {
          const content = (msg as { message: { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> } })
            .message.content;
          for (const block of content) {
            if (block.type === "text" && block.text) {
              // `streamedSoFar` already holds every partial delta we yielded (see
              // the stream_event branch above). The canonical assistant block may
              // repeat that text AND carry spans the partials skipped (e.g. the
              // text AFTER a tool_use). Emit ONLY the genuinely-missing tail so we
              // never duplicate streamed text, while still recovering any dropped
              // span. A normal turn where partials already carried everything
              // yields nothing here.
              const missing = recoverMissing(streamedSoFar, block.text);
              if (missing) {
                const r = shouldStartRound({ roundActive, pendingNewRound }, "text");
                if (r.start) yield { kind: "roundStart" };
                roundActive = r.roundActive;
                pendingNewRound = r.pendingNewRound;
                yield { kind: "text", delta: missing };
                streamedSoFar += missing;
              }
            } else if (block.type === "tool_use") {
              const name = block.name ?? "tool";
              if (block.id) toolNames.set(block.id, name);
              yield { kind: "tool", name, summary: summarizeToolInput(block.input) };
              // A tool was used → the next incoming delta starts a new round.
              const r = shouldStartRound({ roundActive, pendingNewRound }, "tool");
              roundActive = r.roundActive;
              pendingNewRound = r.pendingNewRound;
            }
          }
          break;
        }
        case "user": {
          // Tool results arrive as `user` messages with tool_result content blocks.
          const content = (msg as { message: { content: string | Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> } })
            .message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type !== "tool_result" || !block.tool_use_id) continue;
              const isError = !!block.is_error;
              const text = extractToolResultText(block.content).trim();
              if (!text && !isError) continue;
              const name = toolNames.get(block.tool_use_id) ?? "tool";
              yield { kind: "toolResult", name, content: text || "(error)", isError };
            }
          }
          break;
        }
        case "result": {
          const r = msg as {
            subtype: string;
            result?: string;
            is_error?: boolean;
            total_cost_usd?: number;
            duration_ms?: number;
            usage?: { input_tokens: number; output_tokens: number };
            modelUsage?: Record<string, ModelUsage>;
          };
          done = true;
          // Hitting the agentic-turn cap (maxTurns) is a normal, healthy stop -
          // the session is intact and resumable - not an error to alarm about.
          const turnsExhausted = isMaxTurnsResult(r.subtype);
          const isError = !turnsExhausted && ((r.is_error ?? r.subtype === "error") || isSdkResultError(r.result));
          if (isError) {
            logger.error({ subtype: r.subtype, result: r.result, durationMs: r.duration_ms }, "SDK result error");
          }
          const contextUsagePct = computeContextUsagePct(r.modelUsage);
          yield {
            kind: "done",
            text: isError && r.result ? formatSdkError(r.result) : (r.result ?? ""),
            isError,
            aborted: false,
            turnsExhausted,
            costUsd: r.total_cost_usd,
            durationMs: r.duration_ms,
            usage: r.usage ? { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens } : undefined,
            contextUsagePct,
          };
          break;
        }
      }
    }
    if (!done) {
      const aborted = abortController.signal.aborted;
      yield { kind: "done", text: "", isError: false, aborted, abortedReason: aborted ? (timedOut ? "timeout" : "user") : undefined };
    }
  } catch (err) {
    if (!done) {
      if (abortController.signal.aborted) {
        yield { kind: "done", text: "", isError: false, aborted: true, abortedReason: timedOut ? "timeout" : "user" };
      } else {
        logger.error({ err: String(err) }, "claude query error");
        yield { kind: "error", message: formatSdkError(err instanceof Error ? err.message : String(err)) };
      }
    }
  } finally {
    onFinish();
  }
}

/** Whether an SDK result ended by exhausting the agentic-turn cap (config
 *  claude.maxTurns). This is a normal, healthy stop - the session is intact and
 *  resumable - not a cleanup-with-error terminal state. */
export function isMaxTurnsResult(subtype: string | undefined): boolean {
  return subtype === "error_max_turns";
}

/** Detect if the SDK returned an error in the text result even if subtype was success. */
function isSdkResultError(text?: string): boolean {
  if (!text) return false;
  return (
    text.includes("s.thinking.length") ||
    text.includes("Request rejected (429)") ||
    text.includes("exceeded the monthly usage quota") ||
    text.startsWith("API Error:")
  );
}

/** Format raw SDK / parser errors into clear, actionable messages. */
function formatSdkError(text: string): string {
  if (!text) return "执行发生错误";
  if (text.includes("s.thinking.length")) {
    return "⚠️ 上游模型服务异常：思考流解析中断（通常由于 API 额度超限 429 或代理服务断开引起）";
  }
  if (text.includes("exceeded the monthly usage quota") || text.includes("Request rejected (429)")) {
    return "⚠️ 上游 API 配额超限 (429)：月度用量已达上限，请检查 API Key 额度或更换 Key";
  }
  return text;
}

/** Cap inlined text-file content so a giant log can't blow the context window. */
const TEXT_FILE_MAX_CHARS = 200_000;

/**
 * Turn the bot-layer {@link PromptInput} into what the SDK expects: a plain
 * `string` when there's no media (the fast streaming path), or an
 * `AsyncIterable<SDKUserMessage>` carrying one user message with multimodal
 * content blocks (text + base64 images + PDF documents + inlined text files)
 * when there is. A single-yield async generator is enough; the SDK consumes it
 * and treats the generator's completion as end-of-input.
 */
export function buildSdkPrompt(input: PromptInput): string | AsyncIterable<SDKUserMessage> {
  if (!input.media || input.media.length === 0) return input.text;
  return toUserMessages(input);
}

/**
 * Pure decision for "round" (agentic-turn) boundaries. Text/thinking deltas
 * open a new round the first time overall, and again after a tool-using turn
 * (signalled by `pendingNewRound`); a tool_use block sets `pendingNewRound` so
 * the *next* delta starts the following round. Extracted so the boundary logic
 * is unit-testable without mocking the Claude Agent SDK.
 */
/**
 * Recover the part of a canonical `assistant` text block that has not yet been
 * streamed. Returns the missing tail (after the longest suffix of `streamed`
 * that is also a prefix of `block`), or "" when the block is already fully
 * covered by what we yielded — so normal turns yield nothing and we never
 * duplicate streamed text, but text the partial deltas skipped (e.g. the span
 * after a tool_use) is recovered and re-emitted.
 */
export function recoverMissing(streamed: string, block: string): string {
  if (!block) return "";
  if (streamed.includes(block)) return ""; // already fully streamed
  let overlap = 0;
  const maxK = Math.min(streamed.length, block.length);
  for (let k = 1; k <= maxK; k++) {
    if (streamed.slice(streamed.length - k) === block.slice(0, k)) overlap = k;
  }
  return block.slice(overlap);
}

export function shouldStartRound(
  state: { roundActive: boolean; pendingNewRound: boolean },
  kind: "text" | "thinking" | "tool",
): { start: boolean; roundActive: boolean; pendingNewRound: boolean } {
  if (kind === "text" || kind === "thinking") {
    if (state.pendingNewRound || !state.roundActive) {
      return { start: true, roundActive: true, pendingNewRound: false };
    }
    return { start: false, roundActive: state.roundActive, pendingNewRound: state.pendingNewRound };
  }
  // tool_use seen in an assistant message
  return { start: false, roundActive: state.roundActive, pendingNewRound: true };
}

/**
 * Map a single SDK `content_block_delta` into a {@link DriverEvent}, or return
 * null when the delta carries no renderable text (e.g. `signature_delta`).
 *
 * Kept as a standalone pure function so the streaming branch is unit-testable
 * without mocking the Claude Agent SDK.
 */
export function mapContentBlockDelta(
  delta: { type: string; text?: string; thinking?: string },
): DriverEvent | null {
  if (delta.type === "text_delta" && delta.text) {
    return { kind: "text", delta: delta.text };
  }
  if (delta.type === "thinking_delta" && delta.thinking) {
    // Reasoning models stream their chain-of-thought as thinking deltas.
    // Surfacing these breaks the long silence where a 20-minute think is
    // indistinguishable from a hung task. (signature_delta has no text.)
    return { kind: "thinking", delta: delta.thinking };
  }
  return null;
}

/** Build a bot-layer {@link PermissionRequest} from the SDK's canUseTool args. */
export function buildPermissionRequest(
  toolName: string,
  input: Record<string, unknown>,
  opts: {
    requestId: string;
    toolUseID: string;
    title?: string;
    displayName?: string;
    description?: string;
    suggestions?: PermissionUpdate[];
  },
  cwd: string,
): PermissionRequest {
  return {
    requestId: opts.requestId,
    toolUseID: opts.toolUseID,
    toolName,
    input,
    title: opts.title,
    displayName: opts.displayName,
    description: opts.description,
    suggestions: opts.suggestions,
    cwd,
  };
}

/** Map a bot-layer {@link PermissionDecision} to the SDK's PermissionResult.
 *
 *  `originalInput` is required on an allow: the SDK's runtime Zod schema for an
 *  allow control_response REQUIRES `updatedInput` (a record). Returning a bare
 *  `{behavior:"allow"}` fails validation ("expected record, received undefined"
 *  at path ["updatedInput"]) and the tool is rejected as a permission error —
 *  which presented as "the bot won't run Bash / won't write files" across both
 *  default and acceptEdits modes. Passing the original input means "allow, run
 *  the tool exactly as the model requested, unmodified". */
export function toSdkPermissionResult(dec: PermissionDecision, originalInput?: Record<string, unknown>): PermissionResult {
  if (dec.behavior === "allow") {
    return {
      behavior: "allow",
      updatedInput: originalInput,
      updatedPermissions: dec.updatedPermissions as PermissionUpdate[] | undefined,
    };
  }
  return { behavior: "deny", message: dec.message };
}

/** Build a bot-layer {@link UserDialogRequest} from the SDK's onUserDialog args.
 *  Takes the request structurally (not by SDK type name) so the bot layer stays
 *  the only place that names SDK types — the driver is still the SDK boundary. */
export function buildUserDialogRequest(
  req: { dialogKind: string; payload: Record<string, unknown>; toolUseID?: string },
  requestId: string,
): UserDialogRequest {
  return { requestId, dialogKind: req.dialogKind, payload: req.payload, toolUseID: req.toolUseID };
}

/** Map a bot-layer {@link UserDialogResult} to the SDK's UserDialogResult. Never
 *  returns null: the bot layer always settles (completed/cancelled) so the dialog
 *  is never parked on the SDK's fail-closed path (which would hang the worker). */
export function toSdkUserDialogResult(res: UserDialogResult): SdkUserDialogResult {
  if (res.behavior === "completed") return { behavior: "completed", result: res.result };
  return { behavior: "cancelled" };
}

async function* toUserMessages(input: PromptInput): AsyncGenerator<SDKUserMessage> {
  const blocks: ContentBlockParam[] = [];
  if (input.text) blocks.push({ type: "text", text: input.text });
  for (const m of input.media ?? []) for (const b of mediaBlock(m)) blocks.push(b);
  if (blocks.length === 0) blocks.push({ type: "text", text: "(no content)" });
  yield {
    type: "user",
    message: { role: "user", content: blocks },
    parent_tool_use_id: null,
  };
}

/** Map one MediaAttachment to an Anthropic content block (array of 1). */
function mediaBlock(m: MediaAttachment): ContentBlockParam[] {
  if (m.kind === "image")
    return [
      {
        type: "image",
        source: { type: "base64", media_type: m.mediaType, data: m.data.toString("base64") },
      },
    ];
  if (m.kind === "pdf")
    return [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: m.data.toString("base64") },
      },
    ];
  // text file: inline as a fenced block (model can't read arbitrary binary).
  const body = m.data.toString("utf8");
  const truncated = body.length > TEXT_FILE_MAX_CHARS ? body.slice(0, TEXT_FILE_MAX_CHARS) + "\n…[truncated]" : body;
  const label = `${m.fileName} (${m.mediaType || "text"})`;
  return [{ type: "text", text: `📎 ${label}\n\`\`\`\n${truncated}\n\`\`\`` }];
}

function summarizeToolInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "pattern", "url", "query"]) {
      if (typeof o[key] === "string") return truncate(o[key] as string, 100);
    }
  }
  return truncate(JSON.stringify(input), 100);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Parse a model identifier for a `[NNK]` or `[NNM]` suffix and return the
 * implied context window size (tokens). Returns 0 when no suffix is found.
 */
export function parseContextFromModelId(id: string): number {
  const m = id.match(/\[(\d+(?:\.\d+)?)([KM])\]/i);
  if (!m) return 0;
  const num = parseFloat(m[1]!);
  const unit = m[2]!.toUpperCase();
  return Math.round(num * (unit === "M" ? 1_048_576 : unit === "K" ? 1_024 : 1));
}

/**
 * Compute percentage of context window used from per-model usage records.
 *
 * The SDK-provided {@link ModelUsage.contextWindow} is populated from Claude
 * Code's internal model registry which only covers first-party models. Third-
 * party models (e.g. `deepseek-ai/deepseek-v4-pro[1M]`) get a fallback value
 * as small as 2000 tokens. When that happens the raw percentage explodes (e.g.
 * 1373%) even though the conversation hasn't actually exceeded the real window.
 *
 * To compensate, when the raw context-window looks unrealistically small (<2k
 * tokens while actual input exceeds it) we derive the window from the model
 * identifier's `[?M]`/`[?K]` suffix, which the gateway preserves.
 */
export function computeContextUsagePct(modelUsage: Record<string, ModelUsage> | undefined): number | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.entries(modelUsage);
  if (entries.length === 0) return undefined;

  let contextWindow = Math.max(...entries.map(([, e]) => e.contextWindow));
  const totalInputTokens = entries.reduce((sum, [, e]) => sum + e.inputTokens, 0);

  // If the SDK-reported window is tiny but we have substantial input, try
  // to recover from the model / canonical-model name suffix.
  if (contextWindow <= 2000 && totalInputTokens > 0) {
    for (const [key, entry] of entries) {
      const derived = parseContextFromModelId(entry.canonicalModel ?? "") ||
        parseContextFromModelId(key);
      if (derived > 0) { contextWindow = derived; break; }
    }
  }

  if (contextWindow <= 0) return undefined;
  return Math.round((totalInputTokens / contextWindow) * 100);
}

/** Extract readable text from a tool_result content block (string or text-block array). */
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) {
          const t = (b as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("\n");
  }
  return "";
}
