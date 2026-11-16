import type { Config } from "../config.js";
import type { SwitchableModels } from "../claude/models.js";
import { getSharedDshClient, type DshAcpClient } from "./client.js";
import { buildDshEnv } from "./env.js";
import type { AcpConfigOption } from "./types.js";
import { logger } from "../util/logger.js";

/**
 * Model discovery for the dsh engine's /models pick list.
 *
 * ACP advertises the complete, authoritative catalog as the session `model`
 * config option: each value is a JSON tuple `["<provider>","<model>"]` with a
 * human display name and, for some entries, a one-line description. That is a
 * live, credential-aware list (the API-key route lists what the endpoint serves,
 * the account route what the signed-in user owns), so unlike the claude loader
 * it needs no separate spawn and no static merge to be useful.
 *
 * The runtime is shared with runs, so this only pays for the boot (and a
 * `session/new`) on the first call after the bot starts.
 */

/** Convert one advertised value `["provider","model"]` into the `provider/model`
 *  id the bot stores on the binding (same spelling as other engines). Bare
 *  model names are passed through unchanged. */
export function normalizeDshModelId(value: string): string {
  const tuple = parseDshModelTuple(value);
  if (tuple) return `${tuple[0]}/${tuple[1]}`;
  return value.trim();
}

/** Parse `["provider","model"]` (or a bare name) into a tuple. */
export function parseDshModelTuple(value: string): [string, string] | undefined {
  const t = value.trim();
  if (!t.startsWith("[")) return undefined;
  try {
    const raw = JSON.parse(t) as unknown;
    if (Array.isArray(raw) && raw.length === 2 && typeof raw[0] === "string" && typeof raw[1] === "string") {
      return [raw[0], raw[1]];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Model id (`provider/model` or bare name) → the ACP config value. */
export function mapDshModelValue(model: string): string {
  const m = model.trim();
  const tuple = parseDshModelTuple(m);
  if (tuple) return JSON.stringify(tuple);
  const slash = m.indexOf("/");
  if (slash > 0) {
    const provider = m.slice(0, slash);
    const id = m.slice(slash + 1);
    if (provider && id) return JSON.stringify([provider, id]);
  }
  // Bare model name: the runtime resolves it against the default provider route.
  return JSON.stringify(["deepseek-official", m]);
}

/** Flatten a config option's (possibly grouped) entries into pick ids. */
export function collectDshModelIds(options: AcpConfigOption[]): { models: string[]; notes: string[] } {
  const modelOpt = options.find((o) => o.id === "model");
  const entries = (modelOpt as { options?: unknown } | undefined)?.options;
  const models: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const n = node as { value?: unknown; name?: unknown; group?: unknown; options?: unknown };
      if (typeof n.value === "string") {
        const id = normalizeDshModelId(n.value);
        if (!seen.has(id)) {
          seen.add(id);
          models.push(id);
        }
      } else {
        if (typeof n.group === "string") notes.push(`分组: ${n.group}${typeof n.name === "string" ? ` (${n.name})` : ""}`);
        walk(n.options);
      }
    }
  };
  walk(entries);
  return { models, notes };
}

/** Cache window for the advertised catalog (it only changes on credential/model
 *  changes, which also bump a fresh session's options). */
const SUCCESS_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

interface CacheEntry {
  at: number;
  result: SwitchableModels;
}
let cache: CacheEntry | undefined;
let inflight: Promise<SwitchableModels> | undefined;

export function resetDshModelsCache(): void {
  cache = undefined;
  inflight = undefined;
}

/**
 * /models pick list: ACP-advertised catalog first, then the curated
 * `dsh.models` static config entries kept in the bot's own spelling.
 */
export async function listDshModels(config: Config): Promise<SwitchableModels> {
  const now = Date.now();
  if (cache && now - cache.at < (cache.result.models.length ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) {
    return cache.result;
  }
  if (inflight) return inflight;

  inflight = (async (): Promise<SwitchableModels> => {
    const staticModels = config.dsh?.models ?? [];
    try {
      const client = getSharedDshClient({
        executable: config.dsh?.path,
        // Same env the runs use, so the catalog comes from the same credentials
        // and the same proxy the turn will use.
        env: buildDshEnv({ permissionMode: config.dsh?.permissionMode ?? "workspace-write" }),
      });
      const t0 = Date.now();
      // A throwaway session is the cheapest way to make the runtime publish its
      // catalog; it is closed right after so it never shows up as a live session.
      const session = await client.newSession(process.cwd());
      const { models, notes } = collectDshModelIds(session.configOptions ?? client.configOptions());
      const sid = session.sessionId;
      if (sid) void client.closeSession(sid);
      const merged: string[] = [...staticModels];
      const seen = new Set(merged);
      for (const m of models) {
        if (!seen.has(m)) {
          seen.add(m);
          merged.push(m);
        }
      }
      const result: SwitchableModels = {
        models: merged.slice(0, 50),
        note: `已从 DeepSeek Harness 获取 ${models.length} 个模型（${((Date.now() - t0) / 1000).toFixed(1)}s，缓存 10 分钟）${notes.length ? ` · ${notes.slice(0, 2).join(" / ")}` : ""}`,
      };
      cache = { at: Date.now(), result };
      return result;
    } catch (err) {
      logger.warn({ err: String(err) }, "dsh model discovery failed");
      const result: SwitchableModels = {
        models: staticModels.slice(0, 50),
        note: `⚠️ 未能获取 DeepSeek Harness 模型列表（${String(err).slice(0, 80)}），仅显示配置列表`,
      };
      cache = { at: Date.now(), result };
      return result;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** Reasoning effort levels advertised by the runtime (static fallback when the
 *  catalog is unavailable). */
export const DSH_EFFORT_LEVELS = ["off", "low", "high", "max"] as const;

/** The runtime's advertised default effort, for /models' status line. */
export function dshDefaultEffort(client: DshAcpClient): string | undefined {
  const opt = client.configOptions().find((o) => o.id === "reasoning_effort") as { currentValue?: string } | undefined;
  return opt?.currentValue;
}
