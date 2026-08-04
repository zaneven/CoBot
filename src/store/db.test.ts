import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./db.js";

/** In-memory SQLite database shared across tests; tables are truncated before each. */
const store = new Store(":memory:");

beforeEach(() => {
  // Clear all tables between tests — same in-memory DB persists across test
  // functions, so leftover rows from one test would pollute the next.
  (store as any).db.exec("DELETE FROM bindings");
  (store as any).db.exec("DELETE FROM running_tasks");
  (store as any).db.exec("DELETE FROM cron_jobs");
});

// ── bindings ──────〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("getBinding returns undefined for a new chat", () => {
  assert.equal(store.getBinding(42), undefined);
});

test("upsertBinding creates a new binding", () => {
  store.upsertBinding(42, "/path/to/proj", null);
  const b = store.getBinding(42);
  assert.ok(b);
  assert.equal(b!.chatId, 42);
  assert.equal(b!.projectPath, "/path/to/proj");
  assert.equal(b!.sessionId, null);
  assert.ok(b!.createdAt > 0);
  assert.equal(b!.createdAt, b!.updatedAt);
});

test("upsertBinding updates an existing binding", () => {
  store.upsertBinding(42, "/old", null);
  const first = store.getBinding(42)!;
  // Brief pause so updatedAt can differ from createdAt.
  const start = Date.now();
  while (Date.now() === start) { /* spin */ }
  store.upsertBinding(42, "/new", "sess-abc");
  const second = store.getBinding(42)!;
  assert.equal(second.projectPath, "/new");
  assert.equal(second.sessionId, "sess-abc");
  assert.equal(second.createdAt, first.createdAt, "createdAt is preserved across updates");
  assert.ok(second.updatedAt > first.updatedAt, "updatedAt moves forward");
});

test("setSessionId updates the sessionId without touching other fields", () => {
  store.upsertBinding(42, "/proj", null);
  store.setSessionId(42, "sess-xyz");
  const b = store.getBinding(42)!;
  assert.equal(b.sessionId, "sess-xyz");
  assert.equal(b.projectPath, "/proj");
});

test("clearBinding removes the binding", () => {
  store.upsertBinding(42, "/proj", null);
  assert.ok(store.getBinding(42));
  store.clearBinding(42);
  assert.equal(store.getBinding(42), undefined);
});

test("getBinding on a different chat returns that binding, not a cross-chat mix-up", () => {
  store.upsertBinding(1, "/a", null);
  store.upsertBinding(2, "/b", null);
  assert.equal(store.getBinding(1)!.projectPath, "/a");
  assert.equal(store.getBinding(2)!.projectPath, "/b");
});

// ── running tasks ───〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("insertTask + listTasks round-trip", () => {
  store.insertTask({ id: "t1", chatId: 1, projectPath: "/p", sessionId: null,
    prompt: "hello", status: "running", startedAt: 100, endedAt: null });
  store.insertTask({ id: "t2", chatId: 1, projectPath: "/p", sessionId: "sess-foo",
    prompt: "world", status: "done", startedAt: 200, endedAt: 300 });
  const tasks = store.listTasks(1);
  // Most recent first
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]!.id, "t2");
  assert.equal(tasks[0]!.status, "done");
  assert.equal(tasks[0]!.endedAt, 300);
  assert.equal(tasks[1]!.id, "t1");
  assert.equal(tasks[1]!.status, "running");
  assert.equal(tasks[1]!.endedAt, null);
});

test("listTask is per-chat (does not leak across chats)", () => {
  store.insertTask({ id: "t-a", chatId: 10, projectPath: "/a", sessionId: null,
    prompt: "a", status: "running", startedAt: 1, endedAt: null });
  store.insertTask({ id: "t-b", chatId: 20, projectPath: "/b", sessionId: null,
    prompt: "b", status: "done", startedAt: 2, endedAt: 3 });
  assert.equal(store.listTasks(10).length, 1);
  assert.equal(store.listTasks(20).length, 1);
});

test("updateTaskStatus changes status and endedAt", () => {
  store.insertTask({ id: "t1", chatId: 1, projectPath: "/project", sessionId: null,
    prompt: "hi", status: "running", startedAt: 1, endedAt: null });
  store.updateTaskStatus("t1", "done", 999);
  const t = store.listTasks(1)[0]!;
  assert.equal(t.status, "done");
  assert.equal(t.endedAt, 999);
});

test("sweepStaleRunning marks running tasks as aborted", () => {
  store.insertTask({ id: "t1", chatId: 1, projectPath: "/p", sessionId: null,
    prompt: "a", status: "running", startedAt: 7, endedAt: null });
  store.insertTask({ id: "t2", chatId: 1, projectPath: "/p", sessionId: null,
    prompt: "b", status: "done", startedAt: 8, endedAt: 9 });
  store.insertTask({ id: "t3", chatId: 2, projectPath: "/q", sessionId: null,
    prompt: "c", status: "running", startedAt: 10, endedAt: null });
  const swept = (store as any).db.prepare(
    "UPDATE running_tasks SET status = 'aborted', ended_at = ? WHERE status = 'running'"
  ).run(Date.now());
  assert.equal(swept.changes, 2);
  // Now both running tasks should have been swept.
  const tasks1 = (store as any).db.prepare("SELECT * FROM running_tasks WHERE chat_id = 1").all() as any[];
  assert.equal(tasks1.find((t: any) => t.id === "t1").status, "aborted");
  assert.equal(tasks1.find((t: any) => t.id === "t2").status, "done");
  const tasks2 = (store as any).db.prepare("SELECT * FROM running_tasks WHERE chat_id = 2").all() as any[];
  assert.equal(tasks2.find((t: any) => t.id === "t3").status, "aborted");
});

// ── cron jobs ─────〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("insertCron + listCron round-trip", () => {
  store.insertCron({ id: "c1", chatId: 1, projectPath: "/p", schedule: "0 9 * * *",
    prompt: "morning", claudeSessionId: null, enabled: 1, createdAt: 100, lastRunAt: null });
  store.insertCron({ id: "c2", chatId: 1, projectPath: "/p", schedule: "30 18 * * *",
    prompt: "evening", claudeSessionId: "s-1", enabled: 0, createdAt: 200, lastRunAt: null });
  const jobs = store.listCron(1);
  assert.equal(jobs.length, 2);
  // Newest first
  assert.equal(jobs[0]!.id, "c2");
  assert.equal(jobs[0]!.enabled, 0);
  assert.equal(jobs[1]!.id, "c1");
  assert.equal(jobs[1]!.enabled, 1);
});

test("getCron picks a single job by id", () => {
  store.insertCron({ id: "c1", chatId: 1, projectPath: "/api", schedule: "0 9 * * *",
    prompt: "hi", claudeSessionId: null, enabled: 1, createdAt: 1, lastRunAt: null });
  const job = store.getCron("c1");
  assert.ok(job);
  assert.equal(job!.chatId, 1);
  assert.equal(job!.schedule, "0 9 * * *");
});

test("getCron returns undefined for missing ID", () => {
  assert.equal(store.getCron("nope"), undefined);
});

test("deleteCron removes and is scoped to chat", () => {
  store.insertCron({ id: "c1", chatId: 1, projectPath: "/api", schedule: "*/5 * * * *",
    prompt: "x", claudeSessionId: null, enabled: 1, createdAt: 1, lastRunAt: null });
  // wrong chat: should NOT delete
  assert.equal(store.deleteCron(2, "c1"), false);
  assert.ok(store.getCron("c1"));
  // right chat: deletes
  assert.equal(store.deleteCron(1, "c1"), true);
  assert.equal(store.getCron("c1"), undefined);
});

test("setCronLastRun updates the timestamp", () => {
  store.insertCron({ id: "c1", chatId: 1, projectPath: "/api", schedule: "0 0 * * *",
    prompt: "x", claudeSessionId: null, enabled: 1, createdAt: 1, lastRunAt: null });
  store.setCronLastRun("c1", 9999);
  assert.equal(store.getCron("c1")!.lastRunAt, 9999);
});

test("setCronSessionId updates the session ID", () => {
  store.insertCron({ id: "c1", chatId: 1, projectPath: "/api", schedule: "0 0 * * *",
    prompt: "x", claudeSessionId: null, enabled: 1, createdAt: 1, lastRunAt: null });
  store.setCronSessionId("c1", "sess-42");
  assert.equal(store.getCron("c1")!.claudeSessionId, "sess-42");
});

test("listAllCron only returns enabled jobs", () => {
  store.insertCron({ id: "c1", chatId: 1, projectPath: "/api", schedule: "0 0 * * *",
    prompt: "enabled one", claudeSessionId: null, enabled: 1, createdAt: 100, lastRunAt: null });
  store.insertCron({ id: "c2", chatId: 1, projectPath: "/api", schedule: "0 12 * * *",
    prompt: "disabled one", claudeSessionId: null, enabled: 0, createdAt: 200, lastRunAt: null });
  store.insertCron({ id: "c3", chatId: 2, projectPath: "/q", schedule: "0 18 * * *",
    prompt: "other chat", claudeSessionId: null, enabled: 1, createdAt: 300, lastRunAt: null });
  const all = store.listAllCron();
  assert.equal(all.length, 2);
  const ids = all.map((j) => j.id).sort();
  assert.deepEqual(ids, ["c1", "c3"]);
});

test("setCronEnabled toggles enabled flag", () => {
  store.insertCron({ id: "c1", chatId: 1, projectPath: "/api", schedule: "0 0 * * *",
    prompt: "x", claudeSessionId: null, enabled: 1, createdAt: 1, lastRunAt: null });
  store.setCronEnabled("c1", 0);
  assert.equal(store.getCron("c1")!.enabled, 0);
  store.setCronEnabled("c1", 1);
  assert.equal(store.getCron("c1")!.enabled, 1);
});