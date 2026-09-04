import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { SessionInfo } from "../claude/sessions.js";
import { logger } from "../util/logger.js";

/**
 * Resolve path to the Antigravity conversation summaries SQLite database.
 */
export function getAGyDatabasePath(): string {
  if (process.env.AGY_DB_PATH) return process.env.AGY_DB_PATH;
  return join(homedir(), ".gemini", "antigravity-cli", "conversation_summaries.db");
}

/**
 * List AGy sessions from the local SQLite database.
 */
export async function listAGySessions(dir?: string, limit = 20): Promise<SessionInfo[]> {
  const dbPath = getAGyDatabasePath();
  if (!existsSync(dbPath)) {
    logger.debug({ dbPath }, "agy conversation db does not exist; returning empty");
    return [];
  }

  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      let rows: Array<{
        conversation_id: string;
        title: string;
        preview: string;
        last_modified_time: string;
        workspace_uris: string;
      }>;

      if (dir) {
        const needle = `file://${dir}`.toLowerCase();
        // workspace_uris is a JSON array of strings, e.g. ["file:///path/to/project"]
        const stmt = db.prepare(`
          SELECT conversation_id, title, preview, last_modified_time, workspace_uris
          FROM conversation_summaries
          WHERE LOWER(workspace_uris) LIKE ?
          ORDER BY last_modified_time DESC
          LIMIT ?
        `);
        rows = stmt.all(`%${needle}%`, limit) as typeof rows;
      } else {
        const stmt = db.prepare(`
          SELECT conversation_id, title, preview, last_modified_time, workspace_uris
          FROM conversation_summaries
          ORDER BY last_modified_time DESC
          LIMIT ?
        `);
        rows = stmt.all(limit) as typeof rows;
      }

      return rows.map((r) => {
        const title = (r.title || "").trim();
        const preview = (r.preview || "").replace(/^[#\s]+/, "").trim();
        const summary = title || preview.slice(0, 80) || "(untitled session)";
        let lastModified = Date.now();
        if (r.last_modified_time) {
          const parsed = Date.parse(r.last_modified_time);
          if (!Number.isNaN(parsed)) lastModified = parsed;
        }

        return {
          sessionId: r.conversation_id,
          summary,
          firstPrompt: preview ? preview.slice(0, 120) : undefined,
          lastModified,
        };
      });
    } finally {
      db.close();
    }
  } catch (err) {
    logger.warn({ err: String(err), dbPath }, "failed to read agy conversation db");
    return [];
  }
}

/**
 * Find an AGy session by ID.
 */
export async function findAGySession(sessionId: string): Promise<SessionInfo | undefined> {
  const dbPath = getAGyDatabasePath();
  if (!existsSync(dbPath)) return undefined;

  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const stmt = db.prepare(`
        SELECT conversation_id, title, preview, last_modified_time
        FROM conversation_summaries
        WHERE conversation_id = ?
        LIMIT 1
      `);
      const row = stmt.get(sessionId) as {
        conversation_id: string;
        title: string;
        preview: string;
        last_modified_time: string;
      } | undefined;

      if (!row) return undefined;

      const title = (row.title || "").trim();
      const preview = (row.preview || "").replace(/^[#\s]+/, "").trim();
      const summary = title || preview.slice(0, 80) || "(untitled session)";
      let lastModified = Date.now();
      if (row.last_modified_time) {
        const parsed = Date.parse(row.last_modified_time);
        if (!Number.isNaN(parsed)) lastModified = parsed;
      }

      return {
        sessionId: row.conversation_id,
        summary,
        firstPrompt: preview ? preview.slice(0, 120) : undefined,
        lastModified,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    logger.warn({ err: String(err), sessionId }, "failed to find agy session by id");
    return undefined;
  }
}
