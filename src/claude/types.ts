/**
 * High-level events emitted by {@link runClaude}, abstracting over the Claude
 * Agent SDK's raw message stream so the bot layer never touches SDK types.
 */
export type DriverEvent =
  | { kind: "init"; sessionId: string; cwd: string; model: string }
  | { kind: "roundStart" }
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "toolResult"; name: string; content: string; isError: boolean }
  | { kind: "status"; status: string }
  | { kind: "done"; text: string; isError: boolean; aborted: boolean; abortedReason?: "timeout" | "user"; turnsExhausted?: boolean; costUsd?: number; durationMs?: number; usage?: { inputTokens: number; outputTokens: number }; contextUsagePct?: number }
  | { kind: "error"; message: string };

/** MIME types the Anthropic image content block accepts as base64. */
export type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * A media attachment to send to Claude Code alongside the text prompt.
 * - `image`: a JPEG/PNG/GIF/WebP, as a base64 image block.
 * - `pdf`: a PDF, as a document block.
 * - `text`: a UTF-8 text/code/log file, inlined as a fenced text block (the
 *   model can't read arbitrary binary, so non-image/non-pdf files are delivered
 *   as their text, truncated to keep context bounded).
 */
export type MediaAttachment =
  | { kind: "image"; mediaType: ImageMime; data: Buffer; fileName?: string }
  | { kind: "pdf"; data: Buffer; fileName?: string }
  | { kind: "text"; mediaType: string; data: Buffer; fileName: string };

/**
 * What the user sent: a text prompt plus optional media attachments. The driver
 * turns this into either a plain string (no media - the fast streaming path) or
 * an `AsyncIterable<SDKUserMessage>` with multimodal content blocks.
 */
export interface PromptInput {
  text: string;
  media?: MediaAttachment[];
}

/**
 * A tool-use permission request forwarded from the SDK's `canUseTool` callback.
 * The driver builds this from the SDK args so the bot layer never touches SDK
 * types.
 */
export interface PermissionRequest {
  /** SDK control_request id — idempotency key (the SDK may redeliver it). */
  requestId: string;
  toolUseID: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Pre-rendered prompt text from the bridge (prefer over toolName+input). */
  title?: string;
  displayName?: string;
  description?: string;
  /** SDK "always allow" suggestions; opaque to the bot layer — passed through. */
  suggestions?: unknown;
  cwd: string;
}

/** A bot-layer decision returned to the driver for mapping to PermissionResult. */
export type PermissionDecision =
  | { behavior: "allow"; updatedPermissions?: unknown }
  | { behavior: "deny"; message: string };

export interface RunParams {
  prompt: PromptInput;
  cwd: string;
  /** Session UUID to resume. Omit to start a fresh session. */
  resume?: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
  additionalDirectories?: string[];
  maxTurns?: number;
  /** Hard wall-clock timeout for one turn (ms). Aborts if exceeded. */
  timeoutMs?: number;
  /** Required true when permissionMode is bypassPermissions. */
  allowDangerouslySkipPermissions?: boolean;
  /** Custom path to local Claude Code executable. */
  claudePath?: string;
  /** External abort signal (e.g. from /stop). */
  signal?: AbortSignal;
  /** Interactive tool-approval handler. When set, `canUseTool` delegates to it
   *  instead of auto-approving. Omit to keep headless auto-approve behavior. */
  canUseToolHandler?: (req: PermissionRequest, signal: AbortSignal) => Promise<PermissionDecision>;
}
