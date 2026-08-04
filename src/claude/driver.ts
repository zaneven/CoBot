import { existsSync } from "node:fs";
import { query, type Options, type SDKMessage, type SDKUserMessage, type ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { DriverEvent, RunParams, PromptInput, MediaAttachment } from "./types.js";
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

  // A headless bot can't answer interactive permission prompts: in acceptEdits
  // mode a non-edit tool (e.g. Bash) blocks on a can_use_tool request that
  // nobody answers, hanging the turn until the watchdog kills it. Auto-approve
  // tool use so tasks actually complete. (bypassPermissions already skips every
  // check, so don't also set canUseTool there - it'd be dead and risks an SDK
  // config conflict.) This is an explicit, user-chosen policy for a personal bot
  // on whitelisted dirs - Claude can run any tool in the bound cwd.
  if (params.permissionMode !== "bypassPermissions") {
    options.canUseTool = async (toolName) => {
      logger.debug({ toolName }, "canUseTool: auto-approved");
      return { behavior: "allow" as const };
    };
  }

  let sawStreamEvent = false;
  let done = false;
  let timedOut = false;
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
          const ev = (msg as { event: { type: string; delta?: { type: string; text?: string } } }).event;
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            sawStreamEvent = true;
            yield { kind: "text", delta: ev.delta.text };
          }
          break;
        }
        case "assistant": {
          const content = (msg as { message: { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> } })
            .message.content;
          for (const block of content) {
            if (block.type === "text" && block.text && !sawStreamEvent) {
              yield { kind: "text", delta: block.text };
            } else if (block.type === "tool_use") {
              const name = block.name ?? "tool";
              if (block.id) toolNames.set(block.id, name);
              yield { kind: "tool", name, summary: summarizeToolInput(block.input) };
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
          const isError = r.is_error ?? r.subtype === "error";
          if (isError) {
            logger.error({ subtype: r.subtype, result: r.result, durationMs: r.duration_ms }, "SDK result error");
          }
          const contextUsagePct = computeContextUsagePct(r.modelUsage);
          yield {
            kind: "done",
            text: r.result ?? "",
            isError,
            aborted: false,
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
        yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      }
    }
  } finally {
    onFinish();
  }
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
 * Compute percentage of context window used from per-model usage records.
 * Uses the model with the largest {@link ModelUsage.contextWindow} as the
 * primary runtime, summing all models' {@link ModelUsage.inputTokens} for the
 * total numerator — this handles both single-model and fallback calls.
 */
function computeContextUsagePct(modelUsage: Record<string, ModelUsage> | undefined): number | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.values(modelUsage);
  if (entries.length === 0) return undefined;
  const primaryWindow = Math.max(...entries.map((e) => e.contextWindow));
  if (primaryWindow <= 0) return undefined;
  const totalInputTokens = entries.reduce((sum, e) => sum + e.inputTokens, 0);
  return Math.round((totalInputTokens / primaryWindow) * 100);
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
