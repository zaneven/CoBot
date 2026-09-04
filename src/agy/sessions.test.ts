import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAGySessions, findAGySession, getAGyDatabasePath } from "./sessions.js";

test("AGy sessions: getAGyDatabasePath respects AGY_DB_PATH env var", () => {
  const orig = process.env.AGY_DB_PATH;
  try {
    process.env.AGY_DB_PATH = "/tmp/test-agy.db";
    assert.equal(getAGyDatabasePath(), "/tmp/test-agy.db");
  } finally {
    if (orig !== undefined) process.env.AGY_DB_PATH = orig;
    else delete process.env.AGY_DB_PATH;
  }
});

test("AGy sessions: returns empty array when db does not exist", async () => {
  const orig = process.env.AGY_DB_PATH;
  try {
    process.env.AGY_DB_PATH = "/path/to/nonexistent/db.sqlite";
    const list = await listAGySessions();
    assert.deepEqual(list, []);
    const session = await findAGySession("none");
    assert.equal(session, undefined);
  } finally {
    if (orig !== undefined) process.env.AGY_DB_PATH = orig;
    else delete process.env.AGY_DB_PATH;
  }
});

test("AGy sessions: reads from SQLite database with workspace filtering and find", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "agy-test-"));
  const dbPath = join(tempDir, "conversation_summaries.db");
  const orig = process.env.AGY_DB_PATH;

  try {
    process.env.AGY_DB_PATH = dbPath;
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT "",
        preview TEXT NOT NULL DEFAULT "",
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time DATETIME NOT NULL,
        workspace_uris TEXT NOT NULL
      );
    `);

    db.prepare(`
      INSERT INTO conversation_summaries (conversation_id, title, preview, last_modified_time, workspace_uris)
      VALUES (?, ?, ?, ?, ?)
    `).run("uuid-1", "First Chat", "### Preview 1", "2026-09-04 08:00:00+00:00", JSON.stringify(["file:///project-a"]));

    db.prepare(`
      INSERT INTO conversation_summaries (conversation_id, title, preview, last_modified_time, workspace_uris)
      VALUES (?, ?, ?, ?, ?)
    `).run("uuid-2", "", "Preview 2 without title", "2026-09-04 09:00:00+00:00", JSON.stringify(["file:///project-b"]));

    db.close();

    // 1. List all (sorted by last_modified_time DESC)
    const all = await listAGySessions();
    assert.equal(all.length, 2);
    assert.equal(all[0]!.sessionId, "uuid-2");
    assert.equal(all[0]!.summary, "Preview 2 without title");
    assert.equal(all[1]!.sessionId, "uuid-1");
    assert.equal(all[1]!.summary, "First Chat");

    // 2. Filter by project-a directory
    const filteredA = await listAGySessions("/project-a");
    assert.equal(filteredA.length, 1);
    assert.equal(filteredA[0]!.sessionId, "uuid-1");

    // 3. Find by ID
    const found1 = await findAGySession("uuid-1");
    assert.ok(found1);
    assert.equal(found1?.sessionId, "uuid-1");
    assert.equal(found1?.summary, "First Chat");

    const foundNone = await findAGySession("uuid-nonexistent");
    assert.equal(foundNone, undefined);
  } finally {
    if (orig !== undefined) process.env.AGY_DB_PATH = orig;
    else delete process.env.AGY_DB_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
