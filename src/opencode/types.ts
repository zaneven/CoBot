import type { DriverEvent, PromptInput, RunParams } from "../claude/types.js";

/**
 * Real `opencode run --format json` event shapes (one JSON object per line,
 * probed against the installed CLI). Every event carries a top-level
 * `sessionID`; the interesting payload lives in `part`, whose `type` mirrors
 * the outer type in kebab-case ("step-start" / "text" / "tool" /
 * "step-finish"). The parser tolerates older shapes too (bare `tool_call`,
 * `tool_result`, `result`), so the interfaces below describe the union of
 * what we accept, not just what the current CLI emits.
 */

export interface OpenCodePart {
  type?: string;
  id?: string;
  messageID?: string;
  sessionID?: string;
  // text / reasoning parts
  text?: string;
  reasoning?: string;
  // tool parts
  tool?: string;
  toolName?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: unknown;
    title?: string;
    metadata?: Record<string, unknown>;
  };
  // step-finish parts
  reason?: string;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { write?: number; read?: number };
  };
  cost?: number;
}

export interface OpenCodeSessionEvent {
  type?: "step_start" | "session" | "init" | "start";
  timestamp?: number;
  sessionID?: string;
  sessionId?: string;
  id?: string;
  cwd?: string;
  model?: string;
  part?: OpenCodePart;
}

export interface OpenCodeDeltaEvent {
  type?: "text" | "reasoning" | "thinking" | "content_block_delta" | "delta" | "content" | "message";
  timestamp?: number;
  sessionID?: string;
  text?: string;
  delta?: string | { text?: string; reasoning?: string };
  part?: OpenCodePart;
}

export interface OpenCodeToolEvent {
  type?: "tool_use" | "tool_call" | "tool" | "tool_result" | "tool_output";
  timestamp?: number;
  sessionID?: string;
  name?: string;
  tool?: string;
  toolName?: string;
  tool_use_id?: string;
  call_id?: string;
  id?: string;
  input?: Record<string, unknown> | string;
  args?: Record<string, unknown> | string;
  output?: unknown;
  content?: unknown;
  is_error?: boolean;
  isError?: boolean;
  part?: OpenCodePart;
}

export interface OpenCodeResultEvent {
  type?: "step_finish" | "result" | "done" | "finish" | "complete";
  timestamp?: number;
  sessionID?: string;
  reason?: string;
  result?: string;
  text?: string;
  is_error?: boolean;
  isError?: boolean;
  cost?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  durationMs?: number;
  tokens?: OpenCodePart["tokens"];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  part?: OpenCodePart;
}

export interface OpenCodeErrorEvent {
  type?: "error" | "session_error";
  error?: string | Error | { message?: string };
  message?: string;
  part?: OpenCodePart;
}

export type OpenCodeEvent =
  | OpenCodeSessionEvent
  | OpenCodeDeltaEvent
  | OpenCodeToolEvent
  | OpenCodeResultEvent
  | OpenCodeErrorEvent
  | Record<string, unknown>;

export { DriverEvent, PromptInput, RunParams };
