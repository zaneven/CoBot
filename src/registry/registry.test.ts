import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry } from "./registry.js";
import type { Store } from "../store/db.js";

// Queue methods don't touch the store; a minimal stub is enough (start/finish
// would call into the DB, but these tests only exercise the queue).
const stubStore = {
  insertTask() {},
  updateTaskStatus() {},
  setSessionId() {},
} as unknown as Store;

test("enqueue assigns 1-based positions and dequeue is FIFO", () => {
  const r = new Registry(stubStore);
  assert.equal(r.enqueue(1, { prompt: { text: "a" }, displayText: "a" }), 1);
  assert.equal(r.enqueue(1, { prompt: { text: "b" }, displayText: "b" }), 2);
  assert.equal(r.queueLength(1), 2);
  assert.equal(r.dequeue(1)?.prompt.text, "a");
  assert.equal(r.dequeue(1)?.prompt.text, "b");
  assert.equal(r.dequeue(1), undefined);
  assert.equal(r.queueLength(1), 0);
});

test("queues are per-chat", () => {
  const r = new Registry(stubStore);
  r.enqueue(1, { prompt: { text: "a" }, displayText: "a" });
  r.enqueue(2, { prompt: { text: "b" }, displayText: "b" });
  assert.equal(r.queueLength(1), 1);
  assert.equal(r.queueLength(2), 1);
  assert.equal(r.dequeue(1)?.prompt.text, "a");
  assert.equal(r.dequeue(2)?.prompt.text, "b");
});

test("dropQueue removes all and returns count", () => {
  const r = new Registry(stubStore);
  r.enqueue(1, { prompt: { text: "a" }, displayText: "a" });
  r.enqueue(1, { prompt: { text: "b" }, displayText: "b" });
  assert.equal(r.dropQueue(1), 2);
  assert.equal(r.queueLength(1), 0);
  assert.equal(r.dropQueue(1), 0);
});

test("queuedItems is a non-mutating snapshot", () => {
  const r = new Registry(stubStore);
  r.enqueue(1, { prompt: { text: "a" }, displayText: "a" });
  const snap = r.queuedItems(1);
  assert.equal(snap.length, 1);
  snap.push({ prompt: { text: "x" }, displayText: "x" });
  assert.equal(r.queueLength(1), 1, "internal queue unaffected by snapshot mutation");
});

test("isActive reflects active runs, not the queue", () => {
  const r = new Registry(stubStore);
  r.enqueue(1, { prompt: { text: "a" }, displayText: "a" });
  assert.equal(r.isActive(1), false, "queued but not yet active");
});

test("auto mode: setAuto / isAuto toggle", () => {
  const r = new Registry(stubStore);
  assert.equal(r.isAuto(1), false);
  r.setAuto(1, true);
  assert.equal(r.isAuto(1), true);
  r.setAuto(1, false);
  assert.equal(r.isAuto(1), false);
});

test("auto mode is per-chat", () => {
  const r = new Registry(stubStore);
  r.setAuto(1, true);
  assert.equal(r.isAuto(1), true);
  assert.equal(r.isAuto(2), false, "chat 2 should not be affected");
});
