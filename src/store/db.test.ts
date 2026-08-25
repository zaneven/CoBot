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
  (store as any).db.exec("DELETE FROM audit_logs");
  (store as any).db.exec("DELETE FROM trace_events");
  (store as any).db.exec("DELETE FROM approval_rules");
  (store as any).db.exec("DELETE FROM queued_tasks");
  (store as any).db.exec("DELETE FROM next_actions");
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

test("sweepStaleRunning marks running tasks as aborted and returns them for notification", () => {
  store.insertTask({ id: "t1", chatId: 1, projectPath: "/p", sessionId: null,
    prompt: "a", status: "running", startedAt: 7, endedAt: null });
  store.insertTask({ id: "t2", chatId: 1, projectPath: "/p", sessionId: null,
    prompt: "b", status: "done", startedAt: 8, endedAt: 9 });
  store.insertTask({ id: "t3", chatId: 2, projectPath: "/q", sessionId: null,
    prompt: "c", status: "running", startedAt: 10, endedAt: null });

  const swept = store.sweepStaleRunning();

  // Only the two 'running' rows are swept, and each carries the chatId /
  // prompt / projectPath the startup notification needs to address the user.
  assert.equal(swept.length, 2);
  const t1 = swept.find((t) => t.id === "t1")!;
  assert.equal(t1.status, "aborted");
  assert.equal(t1.chatId, 1);
  assert.equal(t1.prompt, "a");
  assert.equal(t1.projectPath, "/p");
  assert.equal(typeof t1.endedAt, "number");
  const t3 = swept.find((t) => t.id === "t3")!;
  assert.equal(t3.status, "aborted");
  assert.equal(t3.chatId, 2);
  assert.equal(t3.prompt, "c");
  assert.equal(t3.projectPath, "/q");

  // DB state: the 'running' rows are now aborted; the 'done' row untouched.
  assert.equal(store.listTasks(1).find((t) => t.id === "t1")!.status, "aborted");
  assert.equal(store.listTasks(1).find((t) => t.id === "t2")!.status, "done");
  assert.equal(store.listTasks(2).find((t) => t.id === "t3")!.status, "aborted");
});

test("sweepStaleRunning returns [] when nothing is running", () => {
  assert.deepEqual(store.sweepStaleRunning(), []);
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

// ── audit log ─────〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("insertAudit + listAudit round-trip and ordering", () => {
  store.insertAudit({ id: "a1", chatId: 7, sessionId: "s1", prompt: "do thing",
    tools: JSON.stringify(["Bash", "Read"]), status: "done", costUsd: 0.12, durationMs: 5000,
    inputTokens: 1000, outputTokens: 2000, contextUsagePct: 12, startedAt: 100, endedAt: 105 });
  store.insertAudit({ id: "a2", chatId: 7, sessionId: null, prompt: "another",
    tools: JSON.stringify([]), status: "error", costUsd: null, durationMs: null,
    inputTokens: null, outputTokens: null, contextUsagePct: null, startedAt: 200, endedAt: 201 });
  const logs = store.listAudit(7);
  assert.equal(logs.length, 2);
  assert.equal(logs[0]!.id, "a2", "newest first");
  assert.equal(logs[0]!.status, "error");
  assert.equal(logs[1]!.id, "a1");
  assert.equal(logs[1]!.costUsd, 0.12);
  assert.deepEqual(JSON.parse(logs[1]!.tools), ["Bash", "Read"]);
});

test("sumCostSince and sumTokensSince respect the time window and chat", () => {
  store.insertAudit({ id: "a1", chatId: 7, sessionId: null, prompt: "p",
    tools: "[]", status: "done", costUsd: 1.5, durationMs: 1, inputTokens: 100, outputTokens: 50,
    contextUsagePct: null, startedAt: 100, endedAt: 101 });
  store.insertAudit({ id: "a2", chatId: 7, sessionId: null, prompt: "p",
    tools: "[]", status: "done", costUsd: 2.5, durationMs: 1, inputTokens: 300, outputTokens: 250,
    contextUsagePct: null, startedAt: 200, endedAt: 201 });
  // A different chat must not be counted.
  store.insertAudit({ id: "a3", chatId: 99, sessionId: null, prompt: "p",
    tools: "[]", status: "done", costUsd: 99, durationMs: 1, inputTokens: 999, outputTokens: 999,
    contextUsagePct: null, startedAt: 150, endedAt: 151 });

  assert.equal(store.sumCostSince(7, 0), 4); // 1.5 + 2.5
  assert.equal(store.sumCostSince(7, 150), 2.5); // only the later one
  assert.equal(store.sumTokensSince(7, 0), 700); // 150 + 550
});

// ── queued tasks (persistent task queue) ──〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("queued tasks: enqueue, FIFO dequeue, per-chat isolation", () => {
  store.enqueueTask({ id: "q1", chatId: 1, projectPath: null, prompt: "a", displayText: "a", media: null, origin: "interactive", cronJobId: null, createdAt: 100 });
  store.enqueueTask({ id: "q2", chatId: 1, projectPath: "/p", prompt: "b", displayText: "b", media: null, origin: "interactive", cronJobId: null, createdAt: 200 });
  store.enqueueTask({ id: "q3", chatId: 2, projectPath: null, prompt: "c", displayText: "c", media: null, origin: "interactive", cronJobId: null, createdAt: 150 });

  assert.equal(store.queueLength(1), 2);
  assert.equal(store.queueLength(2), 1);

  const first = store.dequeueTask(1)!;
  assert.equal(first.prompt, "a");
  assert.equal(first.id, "q1");
  assert.equal(store.queueLength(1), 1);

  const second = store.dequeueTask(1)!;
  assert.equal(second.projectPath, "/p");
  assert.equal(store.queueLength(1), 0);
  assert.equal(store.dequeueTask(1), undefined);

  // Chat 2 untouched.
  assert.equal(store.queueLength(2), 1);
  assert.equal(store.dequeueTask(2)!.prompt, "c");
});

test("queued tasks: snapshot ordering, dropQueue, and listAllQueued", () => {
  store.enqueueTask({ id: "q1", chatId: 1, projectPath: null, prompt: "a", displayText: "a", media: null, origin: "interactive", cronJobId: null, createdAt: 100 });
  store.enqueueTask({ id: "q2", chatId: 1, projectPath: null, prompt: "b", displayText: "b", media: null, origin: "cron", cronJobId: "cj1", createdAt: 200 });

  const snap = store.queuedTasks(1);
  assert.deepEqual(snap.map((t) => t.displayText), ["a", "b"]);
  assert.equal(snap[1]!.origin, "cron");
  assert.equal(snap[1]!.cronJobId, "cj1");

  assert.equal(store.listAllQueued().length, 2);
  assert.equal(store.dropQueue(1), 2);
  assert.equal(store.queueLength(1), 0);
  assert.equal(store.listAllQueued().length, 0);
});

// ── next-action buttons (persistent, reusable) ──〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("saveNextAction + getNextAction round-trips label/prompt", () => {
  const id = store.saveNextAction(42, "运行测试", "请运行 npm test");
  const got = store.getNextAction(42, id);
  assert.deepEqual(got, { label: "运行测试", prompt: "请运行 npm test" });
});

test("getNextAction is non-destructive (reusable) and chat-scoped", () => {
  const id = store.saveNextAction(42, "a", "p");
  // Reusable: a second lookup still returns the action.
  assert.ok(store.getNextAction(42, id));
  assert.ok(store.getNextAction(42, id), "id survives a prior lookup");
  // Wrong chat is rejected (no cross-chat leakage).
  assert.equal(store.getNextAction(99, id), undefined);
  // Unknown id is rejected.
  assert.equal(store.getNextAction(42, "does-not-exist"), undefined);
});

test("saveNextAction prunes buttons older than the prune age for that chat", () => {
  const id = store.saveNextAction(42, "fresh", "p");
  // Backdate it past the 14-day prune window, then save another to trigger pruning.
  const old = Date.now() - (Store.NEXT_ACTION_PRUNE_AGE_MS + 1000);
  (store as any).db.prepare("UPDATE next_actions SET created_at = ? WHERE id = ?").run(old, id);
  const newId = store.saveNextAction(42, "new", "p2");
  // The backdated button is gone; the freshly-saved one remains.
  assert.equal(store.getNextAction(42, id), undefined, "stale button pruned on write");
  assert.deepEqual(store.getNextAction(42, newId), { label: "new", prompt: "p2" }, "fresh button persisted");
});

test("dropNextActions clears a chat's buttons and returns the count", () => {
  store.saveNextAction(1, "a", "p");
  store.saveNextAction(1, "b", "p");
  store.saveNextAction(2, "c", "p");
  const removed = store.dropNextActions(1);
  assert.equal(removed, 2);
  // Other chats are untouched.
  assert.equal(store.dropNextActions(2), 1);
});

// ── approval mode + always-allow rules ──〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("binding approvalMode defaults to null and round-trips", () => {
  store.upsertBinding(1, "/p", null);
  assert.equal(store.getBinding(1)!.approvalMode, null);
  store.setApprovalMode(1, "interactive");
  assert.equal(store.getBinding(1)!.approvalMode, "interactive");
  store.setApprovalMode(1, "auto");
  assert.equal(store.getBinding(1)!.approvalMode, "auto");
});

test("approvalMode survives an upsert (not wiped by binding updates)", () => {
  store.upsertBinding(1, "/p", null);
  store.setApprovalMode(1, "interactive");
  store.upsertBinding(1, "/p2", "sess-1"); // e.g. /bind again
  assert.equal(store.getBinding(1)!.approvalMode, "interactive");
  assert.equal(store.getBinding(1)!.projectPath, "/p2");
});

test("always-allow rules: add / list / isAllowed / clear", () => {
  store.upsertBinding(1, "/p", null);
  assert.equal(store.isAlwaysAllowed(1, "Bash"), false);
  store.addAlwaysAllow(1, "Bash");
  store.addAlwaysAllow(1, "Write");
  store.addAlwaysAllow(1, "Bash"); // idempotent
  assert.equal(store.isAlwaysAllowed(1, "Bash"), true);
  assert.equal(store.isAlwaysAllowed(1, "Read"), false);
  assert.deepEqual(store.listAlwaysAllow(1), ["Bash", "Write"]);

  // Remove one.
  assert.equal(store.clearAlwaysAllow(1, "Bash"), 1);
  assert.equal(store.isAlwaysAllowed(1, "Bash"), false);
  assert.deepEqual(store.listAlwaysAllow(1), ["Write"]);

  // Clear all for the chat.
  assert.equal(store.clearAlwaysAllow(1), 1);
  assert.deepEqual(store.listAlwaysAllow(1), []);
});

test("always-allow rules are scoped per chat", () => {
  store.upsertBinding(1, "/p", null);
  store.upsertBinding(2, "/q", null);
  store.addAlwaysAllow(1, "Bash");
  assert.equal(store.isAlwaysAllowed(2, "Bash"), false);
  assert.equal(store.clearAlwaysAllow(2), 0, "chat 2 has no rules");
});

test("insertTraceEvents preserves each event's own createdAt (not a single batch time)", () => {
  store.insertAudit({
    id: "audit-trace-1", chatId: 1, sessionId: null, prompt: "p",
    tools: "[]", status: "done", costUsd: null, durationMs: null,
    inputTokens: null, outputTokens: null, contextUsagePct: null,
    startedAt: 1000, endedAt: 4000,
  });
  // Three events that happened at distinct wall-clock moments during the run.
  store.insertTraceEvents("audit-trace-1", [
    { eventType: "init", eventData: "{}", createdAt: 1000 },
    { eventType: "tool", eventData: '{"name":"Bash"}', createdAt: 2500 },
    { eventType: "text", eventData: '{"content":"done"}', createdAt: 3900 },
  ]);

  const events = store.getTraceEvents("audit-trace-1");
  assert.equal(events.length, 3);
  // Each event keeps the timestamp it was captured at — the bug was that every
  // event shared the batch-insert time, collapsing the timeline.
  assert.deepEqual(events.map((e) => e.createdAt), [1000, 2500, 3900]);
});

test("insertTraceEvents falls back to batch-insert time when createdAt is absent", () => {
  store.insertAudit({
    id: "audit-trace-2", chatId: 1, sessionId: null, prompt: "p",
    tools: "[]", status: "done", costUsd: null, durationMs: null,
    inputTokens: null, outputTokens: null, contextUsagePct: null,
    startedAt: 1000, endedAt: 2000,
  });
  const before = Date.now();
  store.insertTraceEvents("audit-trace-2", [
    { eventType: "init", eventData: "{}" },
    { eventType: "tool", eventData: "{}" },
  ]);
  const events = store.getTraceEvents("audit-trace-2");
  assert.equal(events.length, 2);
  const [first, second] = events;
  assert.ok(first);
  assert.ok(second);
  // Both fall back to ~now, and stay within the bracket around the insert.
  assert.ok(first.createdAt >= before && first.createdAt <= Date.now() + 1);
  assert.equal(first.createdAt, second.createdAt);
});