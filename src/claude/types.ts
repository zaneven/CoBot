/**
 * High-level events emitted by {@link runClaude}, abstracting over the Claude
 * Agent SDK's raw message stream so the bot layer never touches SDK types.
 */
export type DriverEvent =
  | { kind: "init"; sessionId: string; cwd: string; model: string }
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "toolResult"; name: string; content: string; isError: boolean }
  | { kind: "status"; status: string }
  | { kind: "done"; text: string; isError: boolean; aborted: boolean; abortedReason?: "timeout" | "user"; costUsd?: number; durationMs?: number; usage?: { inputTokens: number; outputTokens: number }; contextUsagePct?: number }
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
}
