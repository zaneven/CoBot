import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { resolveClaudeExecutable } from "./driver.js";
import { logger } from "../util/logger.js";

/**
 * Live model discovery for the claude engine's /models pick list: ask the
 * Claude Code CLI which models the current configuration can switch to (the
 * same list the CLI's own /model picker renders), via the Agent SDK control
 * protocol.
 *
 * The gateway behind the CLI usually exposes no model-list HTTP endpoint (the
 * ARK plan gateway 404s on /v1/models), so the CLI itself is the only
 * authoritative source. Spawning a parked CLI session costs ~2-4s, so results
 * are cached in-process (10 min success / 60 s failure) with in-flight
 * deduplication, and merged with the curated `defaults.models` static list.
 */

/** A bot-layer projection of the SDK's ModelInfo (keeps the bot layer free of
 *  SDK types — same boundary rule as driver.ts). */
export interface CliModelInfo {
  /** Model identifier to pass as the SDK `model` option (alias or full id). */
  value: string;
  /** Human-readable display name. */
  displayName: string;
  /** Canonical wire id this value resolves to, when known. */
  resolved?: string;
}

export interface SwitchableModels {
  /** Merged pick list: static config entries first, then discovered ones. */
  models: string[];
  /** What the CLI's `default` alias resolves to (the effective model when no
   *  explicit pick exists), when discovery succeeded. */
  defaultModel?: string;
  /** One-line note about how the list was obtained, for the /models status. */
  note: string;
}

/** Ask a freshly spawned (parked) CLI session for its model list. The prompt
 *  generator never yields, so the CLI sits idle waiting for input while the
 *  control-protocol request completes; we then abort the session. No model API
 *  call is made — this only costs a CLI spawn (~2-4s). */
export async function fetchCliModels(opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ models: CliModelInfo[]; defaultModel?: string }> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`model list timed out after ${timeoutMs}ms`)), timeoutMs);
  async function* parked(): AsyncGenerator<never> {
    await new Promise<never>(() => {}); // never yields; aborted via abortController
  }
  const options: Options = { cwd: opts.cwd ?? process.cwd(), abortController: abort };
  const executable = resolveClaudeExecutable();
  if (executable) options.pathToClaudeCodeExecutable = executable;

  const q = query({ prompt: parked() as AsyncGenerator<never, never, unknown>, options });
  try {
    const rows = await q.supportedModels();
    let defaultModel: string | undefined;
    const models: CliModelInfo[] = [];
    for (const r of rows) {
      if (!r?.value) continue;
      // The `default` row is what the default button already means — record
      // what it resolves to for the status line, but don't list it as a pick.
      if (r.value === "default") {
        defaultModel = r.resolvedModel || undefined;
        continue;
      }
      models.push({ value: r.value, displayName: r.displayName || r.value, resolved: r.resolvedModel || undefined });
    }
    return { models, defaultModel };
  } finally {
    clearTimeout(timer);
    // Tear the parked CLI session down; never leave a zombie child behind.
    try {
      q.close();
    } catch {
      /* already torn down */
    }
  }
}

/** Pure merge: curated static entries keep their configured order first, then
 *  discovered models (deduped exactly, `default` excluded upstream). The result
 *  is capped so a huge gateway catalog can't blow up the keyboard. */
export function mergeModelLists(staticModels: string[], discovered: CliModelInfo[], cap = 50): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of staticModels) {
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  for (const d of discovered) {
    if (d.value && !seen.has(d.value)) {
      seen.add(d.value);
      out.push(d.value);
    }
  }
  return out.slice(0, cap);
}

// ── cache ────────────────────────────────────────────────────────────────

const SUCCESS_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

interface CacheEntry {
  at: number;
  result: SwitchableModels;
}
let cache: CacheEntry | undefined;
let inflight: Promise<SwitchableModels> | undefined;

/** Test seam: drop the cached discovery result. */
export function resetClaudeModelsCache(): void {
  cache = undefined;
  inflight = undefined;
}

/**
 * Build the claude engine's /models pick list: the CLI's live model list
 * (cached) merged with the curated `defaults.models` config list. Never
 * throws — on failure it degrades to the static list plus a note, so /models
 * always renders.
 */
export async function listClaudeModels(config: Config): Promise<SwitchableModels> {
  const now = Date.now();
  if (cache && now - cache.at < (cache.result.models.length ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) {
    return cache.result;
  }
  if (inflight) return inflight;

  inflight = (async (): Promise<SwitchableModels> => {
    const staticModels = config.claude.models ?? [];
    try {
      const t0 = Date.now();
      const { models, defaultModel } = await fetchCliModels();
      const merged = mergeModelLists(staticModels, models);
      const trimmed = merged.length === 50 && (staticModels.length + models.length) > 50;
      const note = trimmed
        ? `已从 Claude Code 获取 ${models.length} 个模型（${((Date.now() - t0) / 1000).toFixed(1)}s，缓存 10 分钟，仅显示前 50）`
        : `已从 Claude Code 获取 ${models.length} 个模型（${((Date.now() - t0) / 1000).toFixed(1)}s，缓存 10 分钟）`;
      const result: SwitchableModels = { models: merged, defaultModel, note };
      cache = { at: Date.now(), result };
      return result;
    } catch (err) {
      logger.warn({ err: String(err) }, "claude model discovery failed");
      const result: SwitchableModels = {
        models: staticModels.slice(0, 50),
        note: `⚠️ 未能获取 Claude Code 模型列表（${String(err).slice(0, 80)}），仅显示配置列表`,
      };
      cache = { at: Date.now(), result };
      return result;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}
