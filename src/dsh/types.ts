/**
 * Wire types for the DeepSeek Harness ACP surface (`dsh --profile acp`).
 *
 * Only the subset CoBot drives is modelled: the standard ACP v1 calls plus the
 * `session/update` variants and the server→client `session/request_permission`
 * request. Payloads are validated defensively (every field optional) because
 * `dsh` is a 0.2.x RC and the shapes may drift.
 *
 * Nothing here is imported by `src/bot/` — the driver converts all of it into
 * {@link DriverEvent}s, keeping the "engine boundary" rule from AGENTS.md §5.1.
 */

/** One advertised model route: ACP encodes it as `["provider","model"]` JSON. */
export interface AcpModelOption {
  value: string;
  name: string;
  description?: string;
}

export interface AcpModelGroup {
  group: string;
  name: string;
  options: AcpModelOption[];
}

export type AcpConfigOption =
  | { id: string; name?: string; category?: string; type: "select"; currentValue?: string; options?: Array<AcpModelGroup | AcpModelOption> }
  | { id: string; name?: string; category?: string; type?: string; currentValue?: string };

/** `initialize` → result. */
export interface AcpInitializeResult {
  protocolVersion?: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: {
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: { close?: unknown; list?: unknown; resume?: unknown };
    mcpCapabilities?: { http?: boolean };
  };
}

/** `session/new` → result (also `session/resume` and `set_config_option`). */
export interface AcpSessionResult {
  sessionId?: string;
  configOptions?: AcpConfigOption[];
}

export interface AcpSessionListEntry {
  sessionId: string;
  cwd: string;
  /** Present in newer ACP revisions; optional here. */
  title?: string;
  updatedAt?: string | number;
}

export interface AcpSessionListResult {
  sessions?: AcpSessionListEntry[];
  nextCursor?: string;
}

/** One tool result content block: `{type:"content", content:{type:"text",…}}`. */
export type AcpToolContent =
  | { type: "content"; content: { type: "text"; text: string } }
  | { type: "diff"; path?: string; oldText?: string | null; newText?: string }
  | { type: string };

export type AcpSessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; messageId?: string; content?: { type?: string; text?: string } }
  | { sessionUpdate: "agent_thought_chunk"; messageId?: string; content?: { type?: string; text?: string } }
  | {
      sessionUpdate: "tool_call";
      toolCallId?: string;
      title?: string;
      kind?: string;
      status?: string;
      rawInput?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId?: string;
      status?: string;
      content?: AcpToolContent[];
      rawOutput?: unknown;
    }
  | { sessionUpdate: "usage_update"; used?: number; size?: number }
  | { sessionUpdate: "config_option_update"; configOptions?: AcpConfigOption[] }
  | ({ sessionUpdate: string } & Record<string, unknown>);

export interface AcpSessionUpdateNotification {
  sessionId?: string;
  update?: AcpSessionUpdate;
}

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | string;

/** Server→client permission prompt for one tool call. */
export interface AcpPermissionRequest {
  sessionId?: string;
  toolCall?: { toolCallId?: string; title?: string };
  options?: Array<{ optionId: string; name?: string; kind?: string }>;
  reason?: string;
}

export type AcpPermissionResult =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };
