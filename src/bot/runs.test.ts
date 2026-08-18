import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store/db.js";
import { Registry } from "../registry/registry.js";
import { submitInteractive, shouldSendFinalAnswer, isRetryableError, isCorruptedResumeError } from "./runs.js";
import type { Config } from "../config.js";
import type { PromptInput } from "../claude/types.js";

// Stub API that records sendMessage calls.
class StubApi {
  messages: string[] = [];
  sendMessage = async (_chatId: number, text: string): Promise<{ message_id: number }> => {
    this.messages.push(text);
    return { message_id: 1 };
  };
}

const MINIMAL_CONFIG = {
  claude: {
    taskTimeoutMs: 10 * 60 * 1000,
    permissionMode: "bypassPermissions" as const,
    allowDangerousSkip: true,
  },
  telegram: { maxEditChars: 3500, pollTimeout: 30, flushMs: 900 },
} as Config;

const PROMPT: PromptInput = { text: "hello" };
const CHAT = 1;

let store: Store;
let registry: Registry;
let api: StubApi;

beforeEach(() => {
  store = new Store(":memory:");
  registry = new Registry(store);
  api = new StubApi();
});

// ── no project bound ──〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("submitInteractive says 'no project' when no binding exists", () => {
  submitInteractive({
    api: api as any,
    chatId: CHAT,
    prompt: PROMPT,
    displayText: "test",
    config: MINIMAL_CONFIG,
    registry,
    store,
  });
  assert.equal(api.messages.length, 1);
  assert.ok(api.messages[0]!.includes("No project selected"));
});

// ── Active run → queue ──〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("submitInteractive enqueues when a task is already running", () => {
  store.upsertBinding(CHAT, "/p", null);
  // Simulate an active run by inserting it directly.
  registry.start(CHAT, "/p", null, { text: "old" }, "old");
  assert.equal(registry.isActive(CHAT), true);

  submitInteractive({
    api: api as any,
    chatId: CHAT,
    prompt: PROMPT,
    displayText: "test",
    config: MINIMAL_CONFIG,
    registry,
    store,
  });
  // Should enqueue, not start (and say "Queued #1").
  assert.equal(api.messages.length, 1);
  assert.ok(api.messages[0]!.includes("Queued #1"));
  assert.equal(registry.queueLength(CHAT), 1, "queue has exactly one item");
  // Finish the active run; the queue should still hold the item.
  registry.finish(CHAT, "done");
  assert.equal(registry.queueLength(CHAT), 1, "queue kept after run finishes");
  // Dequeue and verify the content.
  const item = registry.dequeue(CHAT);
  assert.ok(item);
  assert.equal(item!.prompt.text, "hello");
});

test("submitInteractive enqueues twice when one is already running and one is queued", () => {
  store.upsertBinding(CHAT, "/p", null);
  registry.start(CHAT, "/p", null, { text: "current" }, "task");

  // First enqueue
  submitInteractive({
    api: api as any, chatId: CHAT, prompt: PROMPT, displayText: "first",
    config: MINIMAL_CONFIG, registry, store,
  });
  assert.equal(registry.queueLength(CHAT), 1);

  // Second enqueue
  api.messages = [];
  submitInteractive({
    api: api as any, chatId: CHAT, prompt: { text: "second" }, displayText: "second",
    config: MINIMAL_CONFIG, registry, store,
  });
  assert.equal(registry.queueLength(CHAT), 2);
  assert.ok(api.messages[0]!.includes("Queued #2"));
});

// ── ② final-answer dedupe ──〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

// The last ① message already streams the final round's text live, so when ②
// would just repeat that same text it must be suppressed (no duplicate send).
test("shouldSendFinalAnswer: skips when ② equals the last ① body", () => {
  // Common case: single-round task → last round text == final answer.
  assert.equal(shouldSendFinalAnswer("Here is the result.", "Here is the result."), false);
  // Whitespace-only difference must not force a duplicate.
  assert.equal(shouldSendFinalAnswer("  done  ", "done"), false);
});

test("shouldSendFinalAnswer: sends when ② genuinely differs", () => {
  // Multi-part answer synthesized from the whole transcript.
  assert.equal(
    shouldSendFinalAnswer("Summary: a + b = c", "a = 1"),
    true,
  );
});

test("shouldSendFinalAnswer: sends when there was no ① (empty round body)", () => {
  // No round streamed (e.g. immediate done with only ev.text) → ② is the only
  // place the answer appears, so it must be emitted.
  assert.equal(shouldSendFinalAnswer("answer text", ""), true);
});

test("shouldSendFinalAnswer: never sends an empty answer", () => {
  assert.equal(shouldSendFinalAnswer("", "some body"), false);
  assert.equal(shouldSendFinalAnswer("   ", ""), false);
});

// ── isRetryableError ──────────────────────────────────────────────────────────

test("isRetryableError: detects transient thinking/quota/network errors", () => {
  assert.equal(isRetryableError("undefined is not an object (evaluating 's.thinking.length')"), true);
  assert.equal(isRetryableError("API Error: Request rejected (429) · You have exceeded quota"), true);
  assert.equal(isRetryableError("FetchError: request to https://api.anthropic.com failed, reason: socket hang up"), true);
  assert.equal(isRetryableError("Error: 529 Overloaded"), true);
  assert.equal(isRetryableError("read ECONNRESET"), true);
});

test("isRetryableError: returns false for permanent or empty errors", () => {
  assert.equal(isRetryableError(""), false);
  assert.equal(isRetryableError("SyntaxError: Unexpected token"), false);
  assert.equal(isRetryableError("Project path does not exist"), false);
});

// ── isCorruptedResumeError ────────────────────────────────────────────────────

test("isCorruptedResumeError: detects the missing-thinking 400 from a broken resume", () => {
  assert.equal(
    isCorruptedResumeError(
      "API Error: 400 The request failed because it is missing `messages.content.thinking` parameter. Request id: 0217870140...",
    ),
    true,
  );
  assert.equal(isCorruptedResumeError(""), false);
  assert.equal(isCorruptedResumeError("API Error: 429 rate limited"), false);
});