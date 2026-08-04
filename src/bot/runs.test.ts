import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store/db.js";
import { Registry } from "../registry/registry.js";
import { submitInteractive } from "./runs.js";
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