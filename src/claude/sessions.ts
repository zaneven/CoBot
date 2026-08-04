import {
  listSessions,
  getSessionInfo as sdkGetSessionInfo,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";

export interface SessionInfo {
  sessionId: string;
  summary: string;
  firstPrompt?: string;
  lastModified: number;
}

function mapInfo(s: SDKSessionInfo): SessionInfo {
  return {
    sessionId: s.sessionId,
    summary: s.summary || s.firstPrompt || "(no title)",
    firstPrompt: s.firstPrompt,
    lastModified: s.lastModified,
  };
}

/** List Claude Code sessions for a specific project directory. */
export async function listProjectSessions(dir: string, limit = 20): Promise<SessionInfo[]> {
  const sessions = await listSessions({ dir, limit, includeProgrammatic: true });
  return sessions.map(mapInfo).sort((a, b) => b.lastModified - a.lastModified);
}

/** List Claude Code sessions across all projects. */
export async function listAllSessions(limit = 20): Promise<SessionInfo[]> {
  const sessions = await listSessions({ limit, includeProgrammatic: true });
  return sessions.map(mapInfo).sort((a, b) => b.lastModified - a.lastModified);
}

/** Look up a single session by id (searches all projects). */
export async function findSession(sessionId: string): Promise<SessionInfo | undefined> {
  const s = await sdkGetSessionInfo(sessionId);
  return s ? mapInfo(s) : undefined;
}
