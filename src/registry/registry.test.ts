import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "./registry.js";
import { Store } from "../store/db.js";

// The queue is DB-backed, so tests use a real in-memory store.
const store = new Store(":memory:");
const registry = new Registry(store, { mediaDir: ":memory:media" });

beforeEach(() => {
  (store as any).db.exec("DELETE FROM queued_tasks");
});

test("enqueue assigns 1-based positions and dequeue is FIFO", () => {
  assert.equal(registry.enqueue(1, { prompt: { text: "a" }, displayText: "a" }), 1);
  assert.equal(registry.enqueue(1, { prompt: { text: "b" }, displayText: "b" }), 2);
  assert.equal(registry.queueLength(1), 2);
  assert.equal(registry.dequeue(1)?.prompt.text, "a");
  assert.equal(registry.dequeue(1)?.prompt.text, "b");
  assert.equal(registry.dequeue(1), undefined);
  assert.equal(registry.queueLength(1), 0);
});

test("queues are per-chat", () => {
  registry.enqueue(1, { prompt: { text: "a" }, displayText: "a" });
  registry.enqueue(2, { prompt: { text: "b" }, displayText: "b" });
  assert.equal(registry.queueLength(1), 1);
  assert.equal(registry.queueLength(2), 1);
  assert.equal(registry.dequeue(1)?.prompt.text, "a");
  assert.equal(registry.dequeue(2)?.prompt.text, "b");
});

test("dropQueue removes all and returns count", () => {
  registry.enqueue(1, { prompt: { text: "a" }, displayText: "a" });
  registry.enqueue(1, { prompt: { text: "b" }, displayText: "b" });
  assert.equal(registry.dropQueue(1), 2);
  assert.equal(registry.queueLength(1), 0);
  assert.equal(registry.dropQueue(1), 0);
});

test("queuedItems is a non-mutating snapshot", () => {
  registry.enqueue(1, { prompt: { text: "a" }, displayText: "a" });
  const snap = registry.queuedItems(1);
  assert.equal(snap.length, 1);
  snap.push({ displayText: "x" });
  assert.equal(registry.queueLength(1), 1, "internal queue unaffected by snapshot mutation");
});

test("isActive reflects active runs, not the queue", () => {
  registry.enqueue(1, { prompt: { text: "a" }, displayText: "a" });
  assert.equal(registry.isActive(1), false, "queued but not yet active");
});

test("queued items survive a restart (persisted in store)", () => {
  registry.enqueue(1, { prompt: { text: "a" }, displayText: "a" });
  // A fresh Registry over the same store sees the same queue — no in-memory state.
  const registry2 = new Registry(store, { mediaDir: ":memory:media" });
  assert.equal(registry2.queueLength(1), 1);
  assert.equal(registry2.dequeue(1)?.prompt.text, "a");
});

test("auto mode: setAuto / isAuto toggle", () => {
  assert.equal(registry.isAuto(1), false);
  registry.setAuto(1, true);
  assert.equal(registry.isAuto(1), true);
  registry.setAuto(1, false);
  assert.equal(registry.isAuto(1), false);
});

test("auto mode is per-chat", () => {
  registry.setAuto(1, true);
  assert.equal(registry.isAuto(1), true);
  assert.equal(registry.isAuto(2), false, "chat 2 should not be affected");
});