import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store/db.js";
import { Registry } from "../registry/registry.js";
import { submitInteractive, runTurn, runOne, resolveEngineModel, shouldSendFinalAnswer, buildTraceReply, isRetryableError, isCorruptedResumeError } from "./runs.js";
import type { Config } from "../config.js";
import type { PromptInput, DriverEvent } from "../claude/types.js";

// Stub API that records sendMessage calls.
class StubApi {
  messages: string[] = [];
  sendMessage = async (_chatId: number, text: string): Promise<{ message_id: number }> => {
    this.messages.push(text);
    return { message_id: 1 };
  };
  // dashboard.finalize tries editMessageText first; throwing here forces the
  // sendMessage fallback so the test can capture the settlement card text.
  editMessageText = async (): Promise<void> => { throw new Error("edit not supported in stub"); };
  deleteMessage = async (): Promise<void> => { /* no-op */ };
  sendChatAction = async (): Promise<void> => { /* no-op */ };
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
// ── buildTraceReply ──────────────────────────────────────────────────────────

test("buildTraceReply: returns summary unchanged when there are no intermediate blocks", () => {
  assert.equal(buildTraceReply([], "final summary"), "final summary");
  assert.equal(buildTraceReply(["only block"], "only block"), "only block");
});

test("buildTraceReply: renders each narration block as a blockquote, blocks split by ---", () => {
  const out = buildTraceReply(["step one:", "step two：", "final summary"], "final summary");
  assert.equal(out, "##【执行过程】\n\n> step one\n\n---\n\n> step two\n\n---\n\nfinal summary");
});

test("buildTraceReply: turns each line of a multi-line block into its own blockquote line", () => {
  const out = buildTraceReply(["first:\nsecond：", "summary"], "summary");
  assert.equal(out, "##【执行过程】\n\n> first\n> second\n\n---\n\nsummary");
});

test("buildTraceReply: normalizes existing list and quote markers and strips trailing colons", () => {
  const out = buildTraceReply(["- already bulleted:\n* star too：\n1. numbered:\n> quote too", "summary"], "summary");
  assert.equal(out, "##【执行过程】\n\n> already bulleted\n> star too\n> numbered\n> quote too\n\n---\n\nsummary");
});

test("buildTraceReply: drops the trailing block that duplicates the summary and filters blanks", () => {
  const out = buildTraceReply(["step one:", "   ", "final summary"], "final summary");
  assert.equal(out, "##【执行过程】\n\n> step one\n\n---\n\nfinal summary");
});

// ── runTurn: aborted/timeout must notify (regression) ────────────────────────

// Before the fix, a `done{aborted}` only set flags; the `attemptAborted` guard
// then broke out of the retry loop BEFORE the post-loop `dashboard.finalize
// (aborted)` ran — so a watchdog-timed-out (or /stop-aborted) task left the
// "任务进行中" card frozen with NO settlement message. The user saw silence
// and assumed the task had hung. These inject a fake driver so runTurn is
// exercisable without the real SDK.
test("runTurn: timeout (done{aborted,timeout}) sends a settlement card, not silence", async () => {
  store.upsertBinding(CHAT, "/p", null);
  const fakeDriver = async function* (): AsyncGenerator<DriverEvent> {
    yield { kind: "init", sessionId: "s1", cwd: "/p", model: "m" };
    yield { kind: "done", text: "", isError: false, aborted: true, abortedReason: "timeout" };
  };
  const outcome = await runTurn({
    api: api as unknown as import("grammy").Api,
    chatId: CHAT,
    projectPath: "/p",
    sessionId: null,
    prompt: PROMPT,
    config: MINIMAL_CONFIG,
    registry,
    store,
    origin: "interactive",
    abortSignal: new AbortController().signal,
    runClaudeFn: fakeDriver,
  });
  assert.equal(outcome.status, "aborted");
  const settled = api.messages.some((m) => m.includes("任务已中断") && m.includes("超时"));
  assert.ok(settled, `expected a timeout settlement card, got: ${JSON.stringify(api.messages)}`);
});

test("runTurn: user abort (done{aborted,user}) settles the dashboard too", async () => {
  store.upsertBinding(CHAT, "/p", null);
  const fakeDriver = async function* (): AsyncGenerator<DriverEvent> {
    yield { kind: "init", sessionId: "s2", cwd: "/p", model: "m" };
    yield { kind: "done", text: "", isError: false, aborted: true, abortedReason: "user" };
  };
  const outcome = await runTurn({
    api: api as unknown as import("grammy").Api,
    chatId: CHAT,
    projectPath: "/p",
    sessionId: null,
    prompt: PROMPT,
    config: MINIMAL_CONFIG,
    registry,
    store,
    origin: "interactive",
    abortSignal: new AbortController().signal,
    runClaudeFn: fakeDriver,
  });
  assert.equal(outcome.status, "aborted");
  const settled = api.messages.some((m) => m.includes("任务已中断") && m.includes("用户中断"));
  assert.ok(settled, `expected a user-abort settlement card, got: ${JSON.stringify(api.messages)}`);
});

// ── engine/model surfacing ──〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("resolveEngineModel: chat overrides win, else config defaults", () => {
  const cfg = { ...MINIMAL_CONFIG, backend: "claude" } as Config;
  store.upsertBinding(CHAT, "/p", null);
  // No overrides → config defaults (model undefined = CLI default).
  assert.deepEqual(resolveEngineModel(store, cfg, CHAT), { engine: "claude", model: undefined });

  store.setEngine(CHAT, "opencode");
  store.setModel(CHAT, "gpt-5");
  assert.deepEqual(resolveEngineModel(store, cfg, CHAT), { engine: "opencode", model: "gpt-5" });
});

test("runTurn: captures the driver's resolved model into the outcome and settlement card", async () => {
  store.upsertBinding(CHAT, "/p", null);
  const fakeDriver = async function* (): AsyncGenerator<DriverEvent> {
    yield { kind: "init", sessionId: "s9", cwd: "/p", model: "claude-sonnet-4-5" };
    yield { kind: "done", text: "ok", isError: false, aborted: false };
  };
  const outcome = await runTurn({
    api: api as unknown as import("grammy").Api,
    chatId: CHAT,
    projectPath: "/p",
    sessionId: null,
    prompt: PROMPT,
    config: MINIMAL_CONFIG,
    registry,
    store,
    origin: "interactive",
    abortSignal: new AbortController().signal,
    runClaudeFn: fakeDriver,
  });
  assert.equal(outcome.model, "claude-sonnet-4-5");
  // The settlement card names the engine and model.
  const card = api.messages.find((m) => m.includes("任务执行完成"));
  assert.ok(card, "expected a settlement card");
  assert.ok(card.includes("模型"), `expected engine/model line on the card: ${card}`);
});

test("runOne: persists engine and model onto the audit log", async () => {
  store.upsertBinding(CHAT, "/p", null);
  store.setEngine(CHAT, "opencode");
  store.setModel(CHAT, "gpt-5");
  const fakeDriver = async function* (): AsyncGenerator<DriverEvent> {
    yield { kind: "init", sessionId: "s10", cwd: "/p", model: "gpt-5" };
    yield { kind: "done", text: "done", isError: false, aborted: false };
  };
  await runOne({
    api: api as unknown as import("grammy").Api,
    chatId: CHAT,
    projectPath: "/p",
    sessionId: null,
    prompt: PROMPT,
    displayText: "engine test",
    config: MINIMAL_CONFIG,
    registry,
    store,
    origin: "interactive",
    runClaudeFn: fakeDriver,
  });
  const logs = store.listAudit(CHAT);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]!.engine, "opencode");
  assert.equal(logs[0]!.model, "gpt-5");
});
