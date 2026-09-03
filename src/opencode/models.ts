import { spawn } from "node:child_process";
import type { Config } from "../config.js";
import { resolveOpenCodeExecutable } from "./driver.js";
import type { SwitchableModels } from "../claude/models.js";
import { logger } from "../util/logger.js";

/**
 * Live model discovery for the opencode engine's /models pick list: run
 * `opencode models` (fast, prints one `provider/model` line per entry) and
 * merge with the curated `opencode.models` static config list.
 *
 * Same cache policy as the claude engine lister: 10 min success / 60 s
 * failure, with in-flight deduplication. Never throws — on failure it
 * degrades to the static list plus a note, so /models always renders.
 */

/** Parse `opencode models` output: one `provider/model` id per line. Tolerant
 *  of blank lines and surrounding whitespace; dedupes exactly. */
export function parseOpenCodeModelsOutput(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const id = line.trim();
    if (!id || !id.includes("/") || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Run `opencode models` and collect its stdout. Rejects on non-zero exit or
 *  when the run exceeds the timeout (the child is killed either way). */
export async function fetchOpenCodeModels(opts: { path?: string; timeoutMs?: number } = {}): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const exe = resolveOpenCodeExecutable(opts.path);
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn(exe, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`opencode models timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(parseOpenCodeModelsOutput(stdout));
      else reject(new Error(`opencode models exited ${code}${stderr ? `: ${stderr.slice(0, 120)}` : ""}`));
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

/** Test seam: drop the cached discovery result. */
export function resetOpenCodeModelsCache(): void {
  cache = undefined;
  inflight = undefined;
}

/** Build the opencode engine's /models pick list (static config + live CLI). */
export async function listOpenCodeModels(config: Config): Promise<SwitchableModels> {
  const now = Date.now();
  if (cache && now - cache.at < (cache.result.models.length ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) {
    return cache.result;
  }
  if (inflight) return inflight;

  inflight = (async (): Promise<SwitchableModels> => {
    const staticModels = config.opencode?.models ?? [];
    try {
      const t0 = Date.now();
      const discovered = await fetchOpenCodeModels({ path: config.opencode?.path });
      const seen = new Set(staticModels);
      const merged = [...staticModels, ...discovered.filter((m) => !seen.has(m))].slice(0, 50);
      const note = `已从 OpenCode 获取 ${discovered.length} 个模型（${((Date.now() - t0) / 1000).toFixed(1)}s，缓存 10 分钟）`;
      const result: SwitchableModels = { models: merged, note };
      cache = { at: Date.now(), result };
      return result;
    } catch (err) {
      logger.warn({ err: String(err) }, "opencode model discovery failed");
      const result: SwitchableModels = {
        models: staticModels.slice(0, 50),
        note: `⚠️ 未能获取 OpenCode 模型列表（${String(err).slice(0, 80)}），仅显示配置列表`,
      };
      cache = { at: Date.now(), result };
      return result;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}
