import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import zlib from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "../claude/sessions.js";
import { getSharedDshClient } from "./client.js";
import { logger } from "../util/logger.js";

/**
 * Session listing + log read-back for the dsh engine.
 *
 * Two facts shape this module (verified against dsh 0.2.2-rc.1):
 *  - ACP's `session/list` returns only `{sessionId, cwd}` — no title, no
 *    timestamp — so a usable /sessions list needs the session log.
 *  - The ACP wire carries `usage_update{used,size}` (context occupancy) but
 *    NOT per-turn token counts, so accounting is read from the same log.
 *
 * Logs live at `$DSH_HOME/sessions/<cwd-encoded-dir>/<sessionId>/session.vN.jsonl.zstd`,
 * one zstd frame per appended batch (concatenated, not a single member), so
 * decoding walks the frames. Node's builtin `zstdDecompressSync` handles each
 * member on its own — a whole-file call only returns the first frame.
 */

/** Resolve the harness home: `$DSH_HOME` when set, else `~/.dsh`. */
export function resolveDshHome(): string {
  const env = process.env.DSH_HOME;
  if (env && env.trim()) return env.trim();
  return join(homedir(), ".dsh");
}

/** Encode a cwd the way dsh names its per-project session directories:
 *  `/Users/a1/Develop/CoBot` → `--Users-a1-Develop-CoBot--`. */
export function encodeSessionDir(cwd: string): string {
  return `--${cwd.replace(/\//g, "-").replace(/^-/, "")}--`;
}

/**
 * Node >= 22.15 / >= 23.8 ships zstd on `node:zlib`, but the project's
 * @types/node (20.x) does not declare it yet, so it is looked up structurally.
 * When the running Node lacks it, log-derived data (titles/usage) is skipped
 * and ACP still serves sessions — nothing breaks.
 */
const zstdDecompressSync: ((buf: Buffer) => Buffer) | undefined = (
  zlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }
).zstdDecompressSync;

function zstdMagicIndexes(buf: Buffer): number[] {
  const idx: number[] = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) idx.push(i);
  }
  return idx;
}

/** Decode a (multi-frame) zstd JSONL session log into its records. */
export function decodeSessionLog(buf: Buffer): Array<Record<string, unknown>> {
  const frames = zstdMagicIndexes(buf);
  const chunks: string[] = [];
  if (frames.length === 0) {
    // Uncompressed logs (compression: 'none') are plain newline-delimited lines.
    chunks.push(buf.toString("utf8"));
  } else if (!zstdDecompressSync) {
    logger.debug("node:zlib has no zstd support; skipping compressed dsh session logs");
    return [];
  } else {
    for (let k = 0; k < frames.length; k++) {
      const end = k + 1 < frames.length ? frames[k + 1]! : buf.length;
      try {
        chunks.push(zstdDecompressSync!(buf.subarray(frames[k]!, end)).toString("utf8"));
      } catch (err) {
        logger.debug({ err: String(err), frame: k }, "dsh session log frame failed to decode");
      }
    }
  }
  const records: Array<Record<string, unknown>> = [];
  for (const line of chunks.join("\n").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* torn tail (a crash mid-append) — skip */
    }
  }
  return records;
}

/** Find the newest log file of one session directory. */
function newestLog(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  let best: { path: string; mtime: number } | undefined;
  for (const name of readdirSync(dir)) {
    if (!name.includes("jsonl")) continue;
    const p = join(dir, name);
    try {
      const mtime = statSync(p).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: p, mtime };
    } catch {
      /* unreadable entry — skip */
    }
  }
  return best?.path;
}

/**
 * Read the newest assistant usage of one session from its log.
 * `inputTokens`/`outputTokens` come from the last `assistant/message` record.
 */
export function readLastTurnUsage(sessionId: string): { inputTokens: number; outputTokens: number } | undefined {
  try {
    const root = join(resolveDshHome(), "sessions");
    if (!existsSync(root)) return undefined;
    let logPath: string | undefined;
    for (const projectDir of readdirSync(root)) {
      const candidate = join(join(root, projectDir), sessionId);
      if (existsSync(candidate)) {
        logPath = newestLog(candidate);
        if (logPath) break;
      }
    }
    if (!logPath) return undefined;
    const records = decodeSessionLog(readFileSync(logPath));
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]!;
      if (r.type !== "assistant/message") continue;
      const data = r.data as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined;
      const u = data?.usage;
      if (!u) return undefined;
      return {
        inputTokens: Number(u.inputTokens ?? 0) || 0,
        outputTokens: Number(u.outputTokens ?? 0) || 0,
      };
    }
    return undefined;
  } catch (err) {
    logger.debug({ err: String(err), sessionId }, "dsh usage read-back failed");
    return undefined;
  }
}

/** Title + first prompt of one session, from its log's `session/title` event. */
function readSessionMeta(sessionId: string): { title?: string; firstPrompt?: string; createdAt?: number } | undefined {
  try {
    const root = join(resolveDshHome(), "sessions");
    for (const projectDir of readdirSync(root)) {
      const dir = join(join(root, projectDir), sessionId);
      if (!existsSync(dir)) continue;
      const logPath = newestLog(dir);
      if (!logPath) continue;
      const records = decodeSessionLog(readFileSync(logPath));
      let title: string | undefined;
      let firstPrompt: string | undefined;
      let createdAt: number | undefined;
      for (const r of records) {
        if (r.type === "session" && typeof r.cwd === "string") {
          createdAt = typeof r.createdAt === "number" ? r.createdAt : undefined;
        }
        if (r.type === "session/title") {
          const d = r.data as { title?: unknown } | undefined;
          if (typeof d?.title === "string" && d.title.trim()) title = d.title.trim();
        }
        if (!firstPrompt && r.type === "user/message") {
          const d = r.data as { content?: Array<{ type?: string; text?: string }>; source?: { kind?: string } } | undefined;
          if (d?.source?.kind === "user") {
            const text = d.content?.find((b) => b?.type === "text" && typeof b.text === "string")?.text;
            if (text) firstPrompt = text.slice(0, 200);
          }
        }
      }
      return { title, firstPrompt, createdAt };
    }
    return undefined;
  } catch (err) {
    logger.debug({ err: String(err), sessionId }, "dsh session meta read failed");
    return undefined;
  }
}

/**
 * List dsh sessions for one project directory (or all projects when `dir`
 * is omitted), newest first. Merges ACP's list (which knows live sessions) with
 * the persisted log directories (which know title/time) — ACP alone has no
 * ordering or labels, so the merge is what makes the list usable.
 */
export async function listDshSessions(dir?: string, limit = 20): Promise<SessionInfo[]> {
  const seen = new Map<string, SessionInfo>();
  const root = join(resolveDshHome(), "sessions");

  try {
    if (existsSync(root)) {
      for (const projectDir of readdirSync(root)) {
        for (const sessionId of readdirSync(join(root, projectDir))) {
          const candidateDir = join(join(root, projectDir), sessionId);
          if (!existsSync(candidateDir)) continue;
          const logPath = newestLog(candidateDir);
          if (!logPath) continue;
          let mtime = 0;
          try {
            mtime = statSync(logPath).mtimeMs;
          } catch {
            mtime = Date.now();
          }
          const meta = readSessionMeta(sessionId) ?? {};
          // Project filter: the encoded directory name must match the cwd.
          if (dir && projectDir !== encodeSessionDir(dir)) continue;
          seen.set(sessionId, {
            sessionId,
            summary: meta.title || meta.firstPrompt || "(no title)",
            firstPrompt: meta.firstPrompt,
            lastModified: meta.createdAt && mtime ? mtime : mtime || Date.now(),
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "dsh session scan failed");
  }

  // The ACP list adds the cwd of sessions whose log we could not scan (e.g. a
  // home shared with another dsh surface) and catches sessions created live.
  try {
    const client = getSharedDshClient();
    const listed = await client.listSessions(dir);
    for (const s of listed.sessions ?? []) {
      if (seen.has(s.sessionId)) continue;
      seen.set(s.sessionId, {
        sessionId: s.sessionId,
        summary: s.title || "(dsh session)",
        lastModified: typeof s.updatedAt === "number" ? s.updatedAt : Date.parse(String(s.updatedAt ?? "")) || Date.now(),
      });
    }
  } catch (err) {
    logger.debug({ err: String(err) }, "dsh ACP session list unavailable");
  }

  return [...seen.values()].sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
}

/** Look up one session by id (searches every project). */
export async function findDshSession(sessionId: string): Promise<SessionInfo | undefined> {
  const meta = readSessionMeta(sessionId);
  if (meta) {
    return {
      sessionId,
      summary: meta.title || meta.firstPrompt || "(no title)",
      firstPrompt: meta.firstPrompt,
      lastModified: Date.now(),
    };
  }
  const all = await listDshSessions(undefined, 200);
  return all.find((s) => s.sessionId === sessionId);
}
