import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { logger } from "../util/logger.js";

export interface Binding {
  chatId: number;
  projectPath: string;
  /** Active Claude Code session UUID for this chat (null = fresh next run). */
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunningTask {
  id: string;
  chatId: number;
  projectPath: string;
  sessionId: string | null;
  prompt: string;
  status: "running" | "done" | "aborted" | "error";
  startedAt: number;
  endedAt: number | null;
}

export interface CronJob {
  id: string;
  chatId: number;
  projectPath: string;
  schedule: string;
  prompt: string;
  claudeSessionId: string | null;
  enabled: number;
  createdAt: number;
  lastRunAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bindings (
  chat_id    INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS running_tasks (
  id           TEXT PRIMARY KEY,
  chat_id      INTEGER NOT NULL,
  project_path TEXT NOT NULL,
  session_id   TEXT,
  prompt       TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE TABLE IF NOT EXISTS cron_jobs (
  id                TEXT PRIMARY KEY,
  chat_id           INTEGER NOT NULL,
  project_path      TEXT NOT NULL,
  schedule          TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  claude_session_id TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  last_run_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_running_chat ON running_tasks(chat_id);
CREATE INDEX IF NOT EXISTS idx_cron_chat ON cron_jobs(chat_id);
`;

export class Store {
  private db: DB;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    logger.debug({ dbPath }, "store initialized");
  }

  // ---- bindings ----
  getBinding(chatId: number): Binding | undefined {
    const r = this.db
      .prepare("SELECT chat_id, project_path, session_id, created_at, updated_at FROM bindings WHERE chat_id = ?")
      .get(chatId) as
      | { chat_id: number; project_path: string; session_id: string | null; created_at: number; updated_at: number }
      | undefined;
    if (!r) return undefined;
    return {
      chatId: r.chat_id,
      projectPath: r.project_path,
      sessionId: r.session_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  upsertBinding(chatId: number, projectPath: string, sessionId: string | null = null): void {
    const now = Date.now();
    const existing = this.getBinding(chatId);
    this.db
      .prepare(
        `INSERT INTO bindings (chat_id, project_path, session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET project_path = excluded.project_path, session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(chatId, projectPath, sessionId, existing?.createdAt ?? now, now);
  }

  setSessionId(chatId: number, sessionId: string | null): void {
    this.db.prepare("UPDATE bindings SET session_id = ?, updated_at = ? WHERE chat_id = ?").run(sessionId, Date.now(), chatId);
  }

  clearBinding(chatId: number): void {
    this.db.prepare("DELETE FROM bindings WHERE chat_id = ?").run(chatId);
  }

  // ---- running tasks ----
  insertTask(t: RunningTask): void {
    this.db
      .prepare(
        `INSERT INTO running_tasks (id, chat_id, project_path, session_id, prompt, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.chatId, t.projectPath, t.sessionId, t.prompt, t.status, t.startedAt, t.endedAt);
  }

  updateTaskStatus(id: string, status: RunningTask["status"], endedAt: number | null): void {
    this.db.prepare("UPDATE running_tasks SET status = ?, ended_at = ? WHERE id = ?").run(status, endedAt, id);
  }

  listTasks(chatId: number): RunningTask[] { return this.listTasksByProject(chatId, undefined); }

  listTasksByProject(chatId: number, projectPath?: string): RunningTask[] {
    const [where, params] = projectPath
      ? ["WHERE chat_id = ? AND project_path = ?", [chatId, projectPath]]
      : ["WHERE chat_id = ?", [chatId]];
    const rows = this.db
      .prepare(`SELECT * FROM running_tasks ${where} ORDER BY started_at DESC LIMIT 20`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      chatId: r.chat_id as number,
      projectPath: r.project_path as string,
      sessionId: (r.session_id as string | null) ?? null,
      prompt: r.prompt as string,
      status: r.status as RunningTask["status"],
      startedAt: r.started_at as number,
      endedAt: (r.ended_at as number | null) ?? null,
    }));
  }

  // ---- cron jobs ----
  insertCron(c: CronJob): void {
    this.db
      .prepare(
        `INSERT INTO cron_jobs (id, chat_id, project_path, schedule, prompt, claude_session_id, enabled, created_at, last_run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.chatId, c.projectPath, c.schedule, c.prompt, c.claudeSessionId, c.enabled, c.createdAt, c.lastRunAt);
  }

  listCron(chatId: number): CronJob[] {
    const rows = this.db.prepare("SELECT * FROM cron_jobs WHERE chat_id = ? ORDER BY created_at DESC").all(chatId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      chatId: r.chat_id as number,
      projectPath: r.project_path as string,
      schedule: r.schedule as string,
      prompt: r.prompt as string,
      claudeSessionId: (r.claude_session_id as string | null) ?? null,
      enabled: r.enabled as number,
      createdAt: r.created_at as number,
      lastRunAt: (r.last_run_at as number | null) ?? null,
    }));
  }

  /** Look up a single cron job by id (regardless of enabled state). */
  getCron(id: string): CronJob | undefined {
    const r = this.db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      chatId: r.chat_id as number,
      projectPath: r.project_path as string,
      schedule: r.schedule as string,
      prompt: r.prompt as string,
      claudeSessionId: (r.claude_session_id as string | null) ?? null,
      enabled: r.enabled as number,
      createdAt: r.created_at as number,
      lastRunAt: (r.last_run_at as number | null) ?? null,
    };
  }

  deleteCron(chatId: number, id: string): boolean {
    const res = this.db.prepare("DELETE FROM cron_jobs WHERE id = ? AND chat_id = ?").run(id, chatId);
    return res.changes > 0;
  }

  setCronLastRun(id: string, ts: number): void {
    this.db.prepare("UPDATE cron_jobs SET last_run_at = ? WHERE id = ?").run(ts, id);
  }

  setCronSessionId(id: string, sessionId: string): void {
    this.db.prepare("UPDATE cron_jobs SET claude_session_id = ? WHERE id = ?").run(sessionId, id);
  }

  setCronEnabled(id: string, enabled: 1 | 0): void {
    this.db.prepare("UPDATE cron_jobs SET enabled = ? WHERE id = ?").run(enabled, id);
  }

  listAllCron(): CronJob[] {
    const rows = this.db.prepare("SELECT * FROM cron_jobs WHERE enabled = 1").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      chatId: r.chat_id as number,
      projectPath: r.project_path as string,
      schedule: r.schedule as string,
      prompt: r.prompt as string,
      claudeSessionId: (r.claude_session_id as string | null) ?? null,
      enabled: r.enabled as number,
      createdAt: r.created_at as number,
      lastRunAt: (r.last_run_at as number | null) ?? null,
    }));
  }

  close(): void {
    this.db.close();
  }

  /** Mark any tasks still recorded as 'running' as aborted. Call at startup:
   *  a 'running' row can only exist if the previous process died mid-task. */
  sweepStaleRunning(): number {
    const res = this.db
      .prepare("UPDATE running_tasks SET status = 'aborted', ended_at = ? WHERE status = 'running'")
      .run(Date.now());
    return res.changes;
  }
}
