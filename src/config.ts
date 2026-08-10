import { readFileSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { parse as parseYaml } from "yaml";
import { logger } from "./util/logger.js";

dotenv.config();

export interface HermesConfig {
  enabled: boolean;
  apiUrl?: string;
  apiKey?: string;
}

export interface Config {
  telegramToken: string;
  allowedUsers: Set<number>;
  claude: {
    model?: string;
    permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk" | "auto";
    allowedTools?: string[];
    allowDangerousSkip: boolean;
    /** Hard per-task wall-clock timeout in ms (prevents a hung task from blocking the chat). */
    taskTimeoutMs: number;
    /** Cap on agentic turns per task. Bounds a runaway tool loop so it can't
     *  run all the way to the wall-clock watchdog. Undefined = SDK default. */
    maxTurns?: number;
  };
  dbPath: string;
  projects: string[];
  /** Dev root directories whose immediate subdirectories are switchable projects. */
  devRoots: string[];
  telegram: {
    maxEditChars: number;
    pollTimeout: number;
    flushMs: number;
    /** When false, tool calls (Bash/Read/Write etc.) are not streamed to the
     *  chat — only the final assistant text is shown. SilenceIndicator still
     *  heartbeats so the user knows work is happening. Default: false. */
    showToolCalls: boolean;
  };
  hermes: HermesConfig;
  logLevel: string;
}

interface YamlConfig {
  projects?: string[];
  devRoots?: string[];
  defaults?: { model?: string; maxTurns?: number };
  telegram?: { maxEditChars?: number; pollTimeout?: number; flushMs?: number; showToolCalls?: boolean };
  hermes?: { enabled?: boolean; apiUrl?: string; apiKey?: string };
}

function loadYaml(path: string): YamlConfig {
  if (!existsSync(path)) return {};
  try {
    return parseYaml(readFileSync(path, "utf8")) as YamlConfig;
  } catch (err) {
    logger.warn({ path, err: String(err) }, "failed to parse yaml config, ignoring");
    return {};
  }
}

function envList(name: string): string[] | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Coerce a maxTurns value to a positive int, else undefined (SDK default).
 *  Capped at 200 to bound runaway tool loops even if misconfigured. */
export const MAX_TURNS = 200;
export function clampTurns(v: number | undefined): number | undefined {
  if (!v || !Number.isFinite(v) || v <= 0) return undefined;
  const capped = Math.min(Math.floor(v), MAX_TURNS);
  if (capped < v) {
    logger.warn({ requested: v, capped: MAX_TURNS }, "maxTurns exceeds cap; clamped");
  }
  return capped;
}

export function loadConfig(configPath = resolve(process.cwd(), "config.yaml")): Config {
  const yaml = loadYaml(configPath);

  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set; bot will not start until configured");
  }

  const allowedUsersRaw = process.env.TELEGRAM_ALLOWED_USERS ?? "";
  const allowedUsers = new Set(
    allowedUsersRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n)),
  );

  // Default to acceptEdits: headless (no human at a terminal) must auto-accept
  // file edits, otherwise any edit-write task hangs on a permission prompt nobody
  // can answer. Use /dev tools needing bash writes can still set bypassPermissions.
  const permissionMode = (process.env.CLAUDE_PERMISSION_MODE ?? "acceptEdits") as Config["claude"]["permissionMode"];
  const allowDangerousSkip = (process.env.CLAUDE_ALLOW_DANGEROUS_SKIP_PERMISSIONS ?? "false") === "true";

  if (allowDangerousSkip) {
    logger.warn("CLAUDE_ALLOW_DANGEROUS_SKIP_PERMISSIONS=true — spawned sessions will bypass ALL permission checks");
  }

  const apiKey = process.env.HERMES_API_KEY;
  const hermes: HermesConfig = {
    enabled: yaml.hermes?.enabled ?? false,
    apiUrl: yaml.hermes?.apiUrl ?? process.env.HERMES_API_URL,
    apiKey: yaml.hermes?.apiKey === "${HERMES_API_KEY}" ? apiKey : (yaml.hermes?.apiKey ?? apiKey),
  };

  return {
    telegramToken: token,
    allowedUsers,
    claude: {
      model: process.env.CLAUDE_MODEL ?? yaml.defaults?.model,
      permissionMode,
      allowedTools: envList("CLAUDE_ALLOWED_TOOLS"),
      allowDangerousSkip,
      taskTimeoutMs: Number(process.env.CLAUDE_TASK_TIMEOUT_MS ?? 10 * 60 * 1000),
      maxTurns: clampTurns(process.env.CLAUDE_MAX_TURNS ? Number(process.env.CLAUDE_MAX_TURNS) : yaml.defaults?.maxTurns),
    },
    dbPath: process.env.COBOT_DB_PATH ?? resolve(process.cwd(), "data/cobot.db"),
    projects: (yaml.projects ?? []).map((p) => resolve(p)),
    devRoots: (yaml.devRoots ?? []).map((p) => resolve(p)),
    telegram: {
      maxEditChars: yaml.telegram?.maxEditChars ?? 3500,
      pollTimeout: yaml.telegram?.pollTimeout ?? 30,
      flushMs: yaml.telegram?.flushMs ?? 900,
      showToolCalls: yaml.telegram?.showToolCalls ?? false,
    },
    hermes,
    logLevel: process.env.LOG_LEVEL ?? "info",
  };
}

export function isPathAllowed(config: Config, path: string): boolean {
  const abs = resolve(path);
  if (config.projects.some((p) => abs === p)) return true;
  // Any path at or under a dev root is allowed (switchable projects live there).
  return config.devRoots.some((root) => abs === root || abs.startsWith(root + "/"));
}

export interface DevProject {
  name: string;
  path: string;
}

/** Enumerate immediate subdirectories of configured dev roots (switchable projects). */
export function listDevProjects(config: Config): DevProject[] {
  const out: DevProject[] = [];
  for (const root of config.devRoots) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      out.push({ name: e.name, path: resolve(root, e.name) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
