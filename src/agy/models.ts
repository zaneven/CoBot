import { spawn } from "node:child_process";
import type { Config } from "../config.js";
import { resolveAGyExecutable } from "./driver.js";
import type { SwitchableModels } from "../claude/models.js";
import { logger } from "../util/logger.js";

/**
 * Live model discovery for the agy engine's /models pick list: run `agy models`
 * (fast; prints one `<id>\t<Label>` line per entry, with a "Fetching..."
 * header to skip) and merge with the curated `agy.models` static config list.
 *
 * Same cache policy as the other engines: 10 min success / 60 s failure,
 * with in-flight deduplication. Never throws — on failure it degrades to
 * the static list plus a note, so /models always renders.
 */

/** Parse `agy models` output: one `<id>\t<Label>` line per model. The very
 *  first line is a "Fetching available models..." progress message that must
 *  be skipped; blank lines and the trailing label are tolerated. */
export function parseAGyModelsOutput(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const id = line.split(/\s+/)[0]?.trim();
    if (!id || id.toLowerCase().startsWith("fetch") || id.toLowerCase().startsWith("error") || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export async function fetchAGyModels(opts: { path?: string; timeoutMs?: number } = {}): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const exe = resolveAGyExecutable(opts.path);
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(exe, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agy models timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(parseAGyModelsOutput(stdout));
      else reject(new Error(`agy models exited ${code}${stderr ? `: ${stderr.slice(0, 120)}` : ""}`));
    });
  });
}

const SUCCESS_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

interface CacheEntry {
  at: number;
  result: SwitchableModels;
}
let cache: CacheEntry | undefined;
let inflight: Promise<SwitchableModels> | undefined;

export function resetAGyModelsCache(): void {
  cache = undefined;
  inflight = undefined;
}

export async function listAGyModels(config: Config): Promise<SwitchableModels> {
  const now = Date.now();
  if (cache && now - cache.at < (cache.result.models.length ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) {
    return cache.result;
  }
  if (inflight) return inflight;

  inflight = (async (): Promise<SwitchableModels> => {
    const staticModels = config.agy?.models ?? [];
    try {
      const t0 = Date.now();
      const discovered = await fetchAGyModels({ path: config.agy?.path });
      const seen = new Set(staticModels);
      const merged = [...staticModels, ...discovered.filter((m) => !seen.has(m))].slice(0, 50);
      const note = `已从 Antigravity 获取 ${discovered.length} 个模型（${((Date.now() - t0) / 1000).toFixed(1)}s，缓存 10 分钟）`;
      const result: SwitchableModels = { models: merged, note };
      cache = { at: Date.now(), result };
      return result;
    } catch (err) {
      logger.warn({ err: String(err) }, "agy model discovery failed");
      const result: SwitchableModels = {
        models: staticModels.slice(0, 50),
        note: `⚠️ 未能获取 Antigravity 模型列表（${String(err).slice(0, 80)}），仅显示配置列表`,
      };
      cache = { at: Date.now(), result };
      return result;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}
