import type { DriverEvent, RunParams } from "../claude/types.js";
import type { SessionInfo } from "../claude/sessions.js";
import type { EngineBackend, Config } from "../config.js";
import { runClaude } from "../claude/driver.js";
import { listProjectSessions, listAllSessions, findSession as findClaudeSession } from "../claude/sessions.js";
import { listClaudeModels, type SwitchableModels } from "../claude/models.js";
import { runOpenCode } from "../opencode/driver.js";
import { listOpenCodeSessions, findOpenCodeSession } from "../opencode/sessions.js";
import { listOpenCodeModels } from "../opencode/models.js";
import { runAGy } from "../agy/driver.js";
import { listAGySessions, findAGySession } from "../agy/sessions.js";
import { listAGyModels } from "../agy/models.js";
import { logger } from "../util/logger.js";

export async function* runAgent(params: RunParams, backend: EngineBackend = "claude"): AsyncGenerator<DriverEvent> {
  const chosenBackend = params.backend || backend;
  logger.info({ chosenBackend, model: params.model ?? "(cli default)", cwd: params.cwd, resume: params.resume }, "dispatching task to agent driver");

  if (chosenBackend === "opencode") {
    yield* runOpenCode(params);
  } else if (chosenBackend === "agy") {
    yield* runAGy(params);
  } else {
    yield* runClaude(params);
  }
}

export async function listAgentSessions(
  dir: string,
  backend: EngineBackend = "claude",
  limit = 20,
): Promise<SessionInfo[]> {
  if (backend === "opencode") {
    return listOpenCodeSessions(dir, limit);
  }
  if (backend === "agy") {
    return listAGySessions(dir, limit);
  }
  return listProjectSessions(dir, limit);
}

export async function listAllAgentSessions(
  backend: EngineBackend = "claude",
  limit = 20,
): Promise<SessionInfo[]> {
  if (backend === "opencode") {
    return listOpenCodeSessions(undefined, limit);
  }
  if (backend === "agy") {
    return listAGySessions(undefined, limit);
  }
  return listAllSessions(limit);
}

export async function findAgentSession(
  sessionId: string,
  backend: EngineBackend = "claude",
): Promise<SessionInfo | undefined> {
  if (backend === "opencode") {
    return findOpenCodeSession(sessionId);
  }
  if (backend === "agy") {
    return findAGySession(sessionId);
  }
  return findClaudeSession(sessionId);
}

/**
 * Build the /models pick list for an engine: the CLI's live model list merged
 * with the engine's curated static config list. Each engine's lister caches
 * its own result, so tapping /models repeatedly is cheap.
 */
export async function listAgentModels(
  config: Config,
  backend: EngineBackend = "claude",
): Promise<SwitchableModels> {
  if (backend === "opencode") {
    return listOpenCodeModels(config);
  }
  if (backend === "agy") {
    return listAGyModels(config);
  }
  return listClaudeModels(config);
}
