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
  /** Per-chat tool-approval mode (null = use config default). */
  approvalMode: ApprovalMode | null;
  createdAt: number;
  updatedAt: number;
}

/** Tool-approval mode for a chat. Phase 1 supports auto + interactive. */
export type ApprovalMode = "auto" | "interactive";

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

/** Immutable record of one Claude Code task, for audit and cost accounting. */
export interface AuditLog {
  id: string;
  chatId: number;
  sessionId: string | null;
  prompt: string;
  /** JSON-encoded array of distinct tool names used during the task. */
  tools: string;
  status: "done" | "aborted" | "error";
  costUsd: number | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  contextUsagePct: number | null;
  startedAt: number;
  endedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bindings (
  chat_id    INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  session_id TEXT,
  approval_mode TEXT,
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
CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT PRIMARY KEY,
  chat_id      INTEGER NOT NULL,
  session_id   TEXT,
  prompt       TEXT NOT NULL,
  tools        TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL,
  cost_usd     REAL,
  duration_ms  REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  context_usage_pct REAL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_chat ON audit_logs(chat_id, started_at);
CREATE TABLE IF NOT EXISTS approval_rules (
  chat_id    INTEGER NOT NULL,
  tool_name  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, tool_name)
);
CREATE INDEX IF NOT EXISTS idx_approval_chat ON approval_rules(chat_id);
`;

/** Add columns introduced after the initial schema, idempotently. Older DB
 *  files won't have `bindings.approval_mode` since CREATE TABLE IF NOT EXISTS
 *  doesn't extend existing tables. */
function migrate(db: DB): void {
  const cols = db.prepare("PRAGMA table_info(bindings)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "approval_mode")) {
    db.exec("ALTER TABLE bindings ADD COLUMN approval_mode TEXT");
  }
}

export class Store {
  private db: DB;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    migrate(this.db);
    logger.debug({ dbPath }, "store initialized");
  }

  // ---- bindings ----
  getBinding(chatId: number): Binding | undefined {
    const r = this.db
      .prepare("SELECT chat_id, project_path, session_id, approval_mode, created_at, updated_at FROM bindings WHERE chat_id = ?")
      .get(chatId) as
      | { chat_id: number; project_path: string; session_id: string | null; approval_mode: string | null; created_at: number; updated_at: number }
      | undefined;
    if (!r) return undefined;
    return {
      chatId: r.chat_id,
      projectPath: r.project_path,
      sessionId: r.session_id,
      approvalMode: (r.approval_mode as ApprovalMode | null) ?? null,
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

  /** Set the per-chat tool-approval mode. The binding must already exist. */
  setApprovalMode(chatId: number, mode: ApprovalMode): void {
    this.db.prepare("UPDATE bindings SET approval_mode = ?, updated_at = ? WHERE chat_id = ?").run(mode, Date.now(), chatId);
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

  // ---- audit log ----

  insertAudit(log: AuditLog): void {
    this.db
      .prepare(
        `INSERT INTO audit_logs
           (id, chat_id, session_id, prompt, tools, status, cost_usd, duration_ms, input_tokens, output_tokens, context_usage_pct, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        log.id,
        log.chatId,
        log.sessionId,
        log.prompt,
        log.tools,
        log.status,
        log.costUsd,
        log.durationMs,
        log.inputTokens,
        log.outputTokens,
        log.contextUsagePct,
        log.startedAt,
        log.endedAt,
      );
  }

  /** Total spend (USD) for a chat since `sinceTs` (e.g. start of day). */
  sumCostSince(chatId: number, sinceTs: number): number {
    const r = this.db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM audit_logs WHERE chat_id = ? AND started_at >= ? AND cost_usd IS NOT NULL",
      )
      .get(chatId, sinceTs) as { s: number };
    return r.s;
  }

  /** Total tokens (input + output) for a chat since `sinceTs`. */
  sumTokensSince(chatId: number, sinceTs: number): number {
    const r = this.db
      .prepare(
        "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS s FROM audit_logs WHERE chat_id = ? AND started_at >= ? AND input_tokens IS NOT NULL",
      )
      .get(chatId, sinceTs) as { s: number };
    return r.s;
  }

  listAudit(chatId: number, limit = 20): AuditLog[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_logs WHERE chat_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(chatId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      chatId: r.chat_id as number,
      sessionId: (r.session_id as string | null) ?? null,
      prompt: r.prompt as string,
      tools: (r.tools as string) ?? "[]",
      status: r.status as AuditLog["status"],
      costUsd: (r.cost_usd as number | null) ?? null,
      durationMs: (r.duration_ms as number | null) ?? null,
      inputTokens: (r.input_tokens as number | null) ?? null,
      outputTokens: (r.output_tokens as number | null) ?? null,
      contextUsagePct: (r.context_usage_pct as number | null) ?? null,
      startedAt: r.started_at as number,
      endedAt: (r.ended_at as number | null) ?? null,
    }));
  }

  // ---- approval rules (long-term "always allow") ----

  isAlwaysAllowed(chatId: number, toolName: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM approval_rules WHERE chat_id = ? AND tool_name = ?")
      .get(chatId, toolName);
  }

  addAlwaysAllow(chatId: number, toolName: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO approval_rules (chat_id, tool_name, created_at) VALUES (?, ?, ?)")
      .run(chatId, toolName, Date.now());
  }

  listAlwaysAllow(chatId: number): string[] {
    const rows = this.db
      .prepare("SELECT tool_name FROM approval_rules WHERE chat_id = ? ORDER BY created_at")
      .all(chatId) as { tool_name: string }[];
    return rows.map((r) => r.tool_name);
  }

  /** Remove one rule (toolName set) or all rules for the chat (toolName omitted).
   *  Returns the number of rows deleted. */
  clearAlwaysAllow(chatId: number, toolName?: string): number {
    const res = toolName
      ? this.db.prepare("DELETE FROM approval_rules WHERE chat_id = ? AND tool_name = ?").run(chatId, toolName)
      : this.db.prepare("DELETE FROM approval_rules WHERE chat_id = ?").run(chatId);
    return res.changes;
  }

  // ---- Admin Queries ----

  listAllBindings(): Binding[] {
    const rows = this.db
      .prepare("SELECT chat_id, project_path, session_id, approval_mode, created_at, updated_at FROM bindings ORDER BY updated_at DESC")
      .all() as Array<{ chat_id: number; project_path: string; session_id: string | null; approval_mode: string | null; created_at: number; updated_at: number }>;
    return rows.map((r) => ({
      chatId: r.chat_id,
      projectPath: r.project_path,
      sessionId: r.session_id,
      approvalMode: (r.approval_mode as ApprovalMode | null) ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  listAllAuditLogs(limit = 50, offset = 0): { logs: AuditLog[]; total: number } {
    const countRow = this.db.prepare("SELECT COUNT(*) AS c FROM audit_logs").get() as { c: number };
    const rows = this.db
      .prepare("SELECT * FROM audit_logs ORDER BY started_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as Record<string, unknown>[];
    const logs = rows.map((r) => ({
      id: r.id as string,
      chatId: r.chat_id as number,
      sessionId: (r.session_id as string | null) ?? null,
      prompt: r.prompt as string,
      tools: (r.tools as string) ?? "[]",
      status: r.status as AuditLog["status"],
      costUsd: (r.cost_usd as number | null) ?? null,
      durationMs: (r.duration_ms as number | null) ?? null,
      inputTokens: (r.input_tokens as number | null) ?? null,
      outputTokens: (r.output_tokens as number | null) ?? null,
      contextUsagePct: (r.context_usage_pct as number | null) ?? null,
      startedAt: r.started_at as number,
      endedAt: (r.ended_at as number | null) ?? null,
    }));
    return { logs, total: countRow.c };
  }

  listAllApprovalRules(): Array<{ chatId: number; toolName: string; createdAt: number }> {
    const rows = this.db
      .prepare("SELECT chat_id, tool_name, created_at FROM approval_rules ORDER BY created_at DESC")
      .all() as Array<{ chat_id: number; tool_name: string; created_at: number }>;
    return rows.map((r) => ({
      chatId: r.chat_id,
      toolName: r.tool_name,
      createdAt: r.created_at,
    }));
  }

  getAuditStats(sinceTs = 0): {
    totalTasks: number;
    doneTasks: number;
    errorTasks: number;
    abortedTasks: number;
    totalCostUsd: number;
    totalTokens: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS totalTasks,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS doneTasks,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errorTasks,
           SUM(CASE WHEN status = 'aborted' THEN 1 ELSE 0 END) AS abortedTasks,
           COALESCE(SUM(cost_usd), 0) AS totalCostUsd,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens
         FROM audit_logs
         WHERE started_at >= ?`,
      )
      .get(sinceTs) as Record<string, number>;
    return {
      totalTasks: row.totalTasks || 0,
      doneTasks: row.doneTasks || 0,
      errorTasks: row.errorTasks || 0,
      abortedTasks: row.abortedTasks || 0,
      totalCostUsd: row.totalCostUsd || 0,
      totalTokens: row.totalTokens || 0,
    };
  }

  getAuditLogById(id: string): AuditLog | undefined {
    const r = this.db.prepare("SELECT * FROM audit_logs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      chatId: r.chat_id as number,
      sessionId: (r.session_id as string | null) ?? null,
      prompt: r.prompt as string,
      tools: (r.tools as string) ?? "[]",
      status: r.status as AuditLog["status"],
      costUsd: (r.cost_usd as number | null) ?? null,
      durationMs: (r.duration_ms as number | null) ?? null,
      inputTokens: (r.input_tokens as number | null) ?? null,
      outputTokens: (r.output_tokens as number | null) ?? null,
      contextUsagePct: (r.context_usage_pct as number | null) ?? null,
      startedAt: r.started_at as number,
      endedAt: (r.ended_at as number | null) ?? null,
    };
  }

  getDailyAnalytics(days = 7): Array<{
    date: string;
    totalTasks: number;
    doneTasks: number;
    errorTasks: number;
    abortedTasks: number;
    totalCostUsd: number;
    totalTokens: number;
  }> {
    const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare(
        `SELECT
           strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') AS date,
           COUNT(*) AS totalTasks,
           SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS doneTasks,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errorTasks,
           SUM(CASE WHEN status = 'aborted' THEN 1 ELSE 0 END) AS abortedTasks,
           COALESCE(SUM(cost_usd), 0) AS totalCostUsd,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens
         FROM audit_logs
         WHERE started_at >= ?
         GROUP BY date
         ORDER BY date ASC`,
      )
      .all(sinceTs) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      date: (r.date as string) || "Unknown",
      totalTasks: Number(r.totalTasks || 0),
      doneTasks: Number(r.doneTasks || 0),
      errorTasks: Number(r.errorTasks || 0),
      abortedTasks: Number(r.abortedTasks || 0),
      totalCostUsd: Number(r.totalCostUsd || 0),
      totalTokens: Number(r.totalTokens || 0),
    }));
  }

  getToolUsageDistribution(): Array<{ tool: string; count: number }> {
    const rows = this.db
      .prepare("SELECT tools FROM audit_logs WHERE tools IS NOT NULL AND tools != '' AND tools != '[]'")
      .all() as Array<{ tools: string }>;

    const counts = new Map<string, number>();
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.tools);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const toolName = typeof item === "string" ? item : ((item as any).name || (item as any).tool || String(item));
            counts.set(toolName, (counts.get(toolName) || 0) + 1);
          }
        }
      } catch {}
    }

    return [...counts.entries()]
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count);
  }
}
