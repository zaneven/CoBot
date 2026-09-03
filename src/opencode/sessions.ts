import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { SessionInfo } from "../claude/sessions.js";
import { resolveOpenCodeExecutable } from "./driver.js";
import { logger } from "../util/logger.js";

const execAsync = promisify(exec);

export function parseSessionListOutput(output: string): SessionInfo[] {
  const lines = output.split("\n");
  const sessions: SessionInfo[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Session ID") || trimmed.startsWith("─") || /^\d+\.\d+\.\d+/.test(trimmed)) {
      continue;
    }

    // Matches: ses_xxxxx   <Title>   <Updated Time>
    const match = trimmed.match(/^(ses_[a-zA-Z0-9]+)\s+(.+?)(?:\s{2,}(.+))?$/);
    if (match && match[1] && match[2]) {
      const sessionId: string = match[1];
      const title: string = match[2].trim();
      const updatedStr = match[3]?.trim();
      let lastModified = Date.now();
      if (updatedStr) {
        const parsedTime = Date.parse(updatedStr);
        if (!Number.isNaN(parsedTime)) lastModified = parsedTime;
      }

      sessions.push({
        sessionId,
        summary: title || "(no title)",
        firstPrompt: title,
        lastModified,
      });
    }
  }

  return sessions;
}

/**
 * List OpenCode sessions across all projects or for a specific directory.
 */
export async function listOpenCodeSessions(dir?: string, limit = 20): Promise<SessionInfo[]> {
  const executable = resolveOpenCodeExecutable();
  try {
    const { stdout } = await execAsync(`${executable} session list`, {
      cwd: dir || process.cwd(),
      timeout: 5000,
    });
    const parsed = parseSessionListOutput(stdout);
    return parsed.slice(0, limit);
  } catch (err) {
    logger.warn({ err }, "failed to list opencode sessions");
    return [];
  }
}

/**
 * Find an OpenCode session by id.
 */
export async function findOpenCodeSession(sessionId: string): Promise<SessionInfo | undefined> {
  const sessions = await listOpenCodeSessions(undefined, 100);
  return sessions.find((s) => s.sessionId === sessionId);
}
