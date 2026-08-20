import { readFileSync, writeFileSync, existsSync, readdirSync, type Dirent } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { logger } from "./util/logger.js";
import type { ApprovalMode } from "./store/db.js";

dotenv.config();

export interface HermesConfig {
  enabled: boolean;
  apiUrl?: string;
  apiKey?: string;
}

/** Interactive tool-approval configuration. */
export interface ApprovalConfig {
  /** "auto" = headless auto-approve (default); "interactive" = prompt for
   *  mutating tools (read-only tools in `skipTools` are still auto-allowed). */
  mode: ApprovalMode;
  /** Tool names that never require a prompt (read-only by default). */
  skipTools: string[];
  /** Per-request approval timeout (ms). Must be < taskTimeoutMs. */
  timeoutMs: number;
  /** Decision when the user doesn't respond in time. Default "allow"
   *  (approve when present, auto-run when away). Set "deny" to fail closed. */
  timeoutAction: "allow" | "deny";
}

/** Default read-only tools that skip the approval prompt. */
export const DEFAULT_APPROVAL_SKIP_TOOLS = ["Read", "LS", "Glob", "Grep", "TodoWrite"];

export interface AdminConfig {
  enabled: boolean;
  host: string;
  port: number;
  authEnabled: boolean;
  apiKey: string;
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
     *  run all the way to the wall-clock watchdog. Falls back to
     *  DEFAULT_MAX_TURNS when neither env nor yaml sets a value. */
    maxTurns?: number;
    /** Per-day spend ceiling per chat (USD). When exceeded, new tasks are
     *  rejected with a notice. Undefined = no cap. */
    dailyCostCapUsd?: number;
    /** Per-day token ceiling per chat (input + output). Undefined = no cap. */
    dailyTokenCap?: number;
    /** Interactive tool-approval settings. Omit to keep headless auto-approve. */
    approval?: ApprovalConfig;
  };
  admin: AdminConfig;
  dbPath: string;
  projects: string[];
  /** Dev root directories whose immediate subdirectories are switchable projects. */
  devRoots: string[];
  telegram: {
    maxEditChars: number;
    pollTimeout: number;
    flushMs: number;
  };
  hermes: HermesConfig;
  logLevel: string;
}

export interface YamlConfig {
  projects?: string[];
  devRoots?: string[];
  defaults?: { model?: string; maxTurns?: number; taskTimeoutMs?: number; dailyCostCapUsd?: number; dailyTokenCap?: number };
  telegram?: {
    botToken?: string;
    allowedUsers?: number[] | string;
    maxEditChars?: number;
    pollTimeout?: number;
    flushMs?: number;
  };
  hermes?: { enabled?: boolean; apiUrl?: string; apiKey?: string };
  approval?: { mode?: ApprovalMode; skipTools?: string[]; timeoutMs?: number; timeoutAction?: "allow" | "deny" };
  admin?: { enabled?: boolean; host?: string; port?: number; authEnabled?: boolean; apiKey?: string };
}

export function readRawYamlContent(configPath = resolve(process.cwd(), "config.yaml")): string {
  if (!existsSync(configPath)) return "";
  try {
    return readFileSync(configPath, "utf8");
  } catch {
    return "";
  }
}

export function saveYamlConfig(updates: Partial<YamlConfig>, configPath = resolve(process.cwd(), "config.yaml")): YamlConfig {
  const currentYaml = loadYaml(configPath);
  const merged: YamlConfig = {
    ...currentYaml,
    ...updates,
  };

  if (updates.defaults || currentYaml.defaults) {
    merged.defaults = { ...currentYaml.defaults, ...updates.defaults };
  }
  if (updates.telegram || currentYaml.telegram) {
    merged.telegram = { ...currentYaml.telegram, ...updates.telegram };
  }
  if (updates.approval || currentYaml.approval) {
    merged.approval = { ...currentYaml.approval, ...updates.approval };
  }
  if (updates.admin || currentYaml.admin) {
    merged.admin = { ...currentYaml.admin, ...updates.admin };
  }
  if (updates.hermes || currentYaml.hermes) {
    merged.hermes = { ...currentYaml.hermes, ...updates.hermes };
  }

  const cleanObject = (obj: any): any => {
    if (Array.isArray(obj)) return obj;
    if (obj !== null && typeof obj === "object") {
      const out: any = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) out[k] = cleanObject(v);
      }
      return out;
    }
    return obj;
  };

  const cleaned = cleanObject(merged);
  const yamlString = stringifyYaml(cleaned);
  writeFileSync(configPath, yamlString, "utf8");
  return merged;
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

/** Parse an optional numeric env var (e.g. a cost/token cap). Returns undefined
 *  when unset or non-numeric so yaml defaults can take over. */
function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse an optional non-empty string env var. */
function envStr(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** Coerce a maxTurns value to a positive int, else undefined (SDK default).
 *  Capped at 200 to bound runaway tool loops even if misconfigured. */
export const MAX_TURNS = 200;
/** Conservative default per-task turn cap, applied when neither env nor yaml
 *  configures maxTurns. Bounds runaway tool loops before the wall-clock
 *  watchdog even fires. Set CLAUDE_MAX_TURNS / defaults.maxTurns to override. */
export const DEFAULT_MAX_TURNS = 50;
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

  const token = yaml.telegram?.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN / telegram.botToken not set; bot will not start until configured");
  }

  const allowedUsersRaw = yaml.telegram?.allowedUsers !== undefined
    ? (Array.isArray(yaml.telegram.allowedUsers) ? yaml.telegram.allowedUsers.join(",") : String(yaml.telegram.allowedUsers))
    : (process.env.TELEGRAM_ALLOWED_USERS ?? "");
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

  // Hard per-task wall-clock watchdog (interrupts a hung task). Env overrides
  // yaml; default 10 min. Exposed in the admin panel as "单次任务超时" (minutes).
  const taskTimeoutMs = Number(
    process.env.CLAUDE_TASK_TIMEOUT_MS ?? yaml.defaults?.taskTimeoutMs ?? 10 * 60 * 1000,
  );
  // Approval timeout must be strictly less than the task watchdog, otherwise the
  // watchdog kills the task mid-prompt. Clamp with a 30s safety margin.
  const approvalTimeoutMs = (() => {
    const raw = envNum("COBOT_APPROVAL_TIMEOUT_MS") ?? yaml.approval?.timeoutMs ?? 5 * 60 * 1000;
    const max = taskTimeoutMs - 30_000;
    if (raw >= max) {
      logger.warn({ raw, max }, "approval.timeoutMs >= taskTimeoutMs; clamped");
      return Math.max(60_000, max);
    }
    return raw;
  })();
  const approval: ApprovalConfig = {
    mode: (envStr("COBOT_APPROVAL_MODE") ?? yaml.approval?.mode ?? "auto") as ApprovalMode,
    skipTools: envList("COBOT_APPROVAL_SKIP_TOOLS") ?? yaml.approval?.skipTools ?? DEFAULT_APPROVAL_SKIP_TOOLS,
    timeoutMs: approvalTimeoutMs,
    timeoutAction: (envStr("COBOT_APPROVAL_TIMEOUT_ACTION") ?? yaml.approval?.timeoutAction ?? "allow") as "allow" | "deny",
  };

  const admin: AdminConfig = {
    enabled: (process.env.COBOT_ADMIN_ENABLED ?? (yaml.admin?.enabled ?? true).toString()) === "true",
    host: envStr("COBOT_ADMIN_HOST") ?? yaml.admin?.host ?? "127.0.0.1",
    port: envNum("COBOT_ADMIN_PORT") ?? yaml.admin?.port ?? 8085,
    authEnabled: yaml.admin?.authEnabled ?? true,
    apiKey: envStr("COBOT_ADMIN_API_KEY") ?? yaml.admin?.apiKey ?? "",
  };

  return {
    telegramToken: token,
    allowedUsers,
    claude: {
      model: process.env.CLAUDE_MODEL ?? yaml.defaults?.model,
      permissionMode,
      allowedTools: envList("CLAUDE_ALLOWED_TOOLS"),
      allowDangerousSkip,
      taskTimeoutMs,
      maxTurns: clampTurns(
        process.env.CLAUDE_MAX_TURNS
          ? Number(process.env.CLAUDE_MAX_TURNS)
          : (yaml.defaults?.maxTurns ?? DEFAULT_MAX_TURNS),
      ),
      dailyCostCapUsd: envNum("COBOT_DAILY_COST_CAP_USD") ?? yaml.defaults?.dailyCostCapUsd,
      dailyTokenCap: envNum("COBOT_DAILY_TOKEN_CAP") ?? yaml.defaults?.dailyTokenCap,
      approval,
    },
    admin,
    dbPath: process.env.COBOT_DB_PATH ?? resolve(process.cwd(), "data/cobot.db"),
    projects: (yaml.projects ?? []).map((p) => resolve(p)),
    devRoots: (yaml.devRoots ?? []).map((p) => resolve(p)),
    telegram: {
      maxEditChars: yaml.telegram?.maxEditChars ?? 3500,
      pollTimeout: yaml.telegram?.pollTimeout ?? 30,
      flushMs: yaml.telegram?.flushMs ?? 900,
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
