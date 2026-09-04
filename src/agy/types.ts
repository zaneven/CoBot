import type { DriverEvent, PromptInput, RunParams } from "../claude/types.js";

/**
 * Real `agy --print <prompt> --output-format stream-json` event shapes (one
 * JSON object per line, probed against the installed CLI v1.1.x).
 *
 * The CLI emits exactly three top-level `event` kinds:
 *
 *   {"event":"init","conversation_id":"<uuid>","init":{"cwd":"…","tools":[…],"permission_mode":"always-proceed"}}
 *
 *   {"event":"step_update","step_update":{"conversation_id":"…","step_index":N,
 *       "state":"ACTIVE"|"DONE","step_type":"user_input"|"agent_response"|
 *       "thinking"|"tool"|…,"text_delta":"…"?,
 *       "tool_name":"…"?, "tool_info":{"name":"…","parameters":{…}}?,
 *       "duration_seconds":N?, "usage":{…}?}}
 *
 *   {"event":"result","result":{"conversation_id":"…","status":"SUCCESS"|"ERROR"|…,
 *       "response":"…","duration_seconds":N,"num_turns":N,"usage":{…}}}
 *
 * Notes from probing:
 *  - A step may emit multiple `step_update` lines (ACTIVE with text_delta chunks,
 *    then one DONE carrying the step's usage/duration).
 *  - `text_delta` appears on BOTH active and done lines for an agent_response
 *    step — both are real continuation chunks, both must be accumulated.
 *  - Tool steps come as ACTIVE (tool invoked) then DONE (tool finished). The
 *    DONE line does NOT carry the tool's output content — only duration and
 *    tool_info — so the toolResult we emit has a placeholder content.
 *  - `conversation_id` (top-level on every event) is the resume id reused by
 *    `--conversation <id>`; the `init` event is the canonical source.
 */

export interface AGyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
}

export interface AGyInitPayload {
  cwd?: string;
  tools?: string[];
  permission_mode?: string;
  model?: string;
}

export interface AGyInitEvent {
  event?: "init";
  conversation_id?: string;
  conversationId?: string;
  init?: AGyInitPayload;
}

export interface AGyToolInfo {
  name?: string;
  parameters?: Record<string, unknown>;
  output?: string;
  error?: { type?: string; message?: string } | string;
}

export interface AGyStepUpdate {
  conversation_id?: string;
  conversationId?: string;
  step_index?: number;
  stepIndex?: number;
  state?: string;
  step_type?: string;
  stepType?: string;
  text_delta?: string;
  textDelta?: string;
  tool_name?: string;
  toolName?: string;
  tool_info?: AGyToolInfo;
  toolInfo?: AGyToolInfo;
  duration_seconds?: number;
  durationSeconds?: number;
  usage?: AGyUsage;
}

export interface AGyStepEvent {
  event?: "step_update";
  step_update?: AGyStepUpdate;
  stepUpdate?: AGyStepUpdate;
}

export interface AGyResultPayload {
  conversation_id?: string;
  conversationId?: string;
  status?: string;
  response?: string;
  duration_seconds?: number;
  durationSeconds?: number;
  num_turns?: number;
  numTurns?: number;
  usage?: AGyUsage;
}

export interface AGyResultEvent {
  event?: "result";
  result?: AGyResultPayload;
}

export interface AGyErrorEvent {
  event?: "error";
  error?: string | { message?: string };
  message?: string;
}

export type AGyEvent =
  | AGyInitEvent
  | AGyStepEvent
  | AGyResultEvent
  | AGyErrorEvent
  | Record<string, unknown>;

export { DriverEvent, PromptInput, RunParams };
