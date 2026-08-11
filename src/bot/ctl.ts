import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
// src/bot/ctl.ts → project root is two levels up.
export const ROOT_DIR = resolve(here, "..", "..");
export const SCRIPT = resolve(ROOT_DIR, "scripts", "cobot.sh");
export const BOT_LOG = resolve(ROOT_DIR, "bot.log");

/** Subset of scripts/cobot.sh operations exposed as Telegram commands. */
export type BotCtlAction = "start" | "stop" | "restart" | "install";

export interface CtlResult {
  ok: boolean;
  code: number | null;
  output: string;
}

/**
 * Whether THIS process was launched in hot-reload (`tsx watch`) mode. Set by the
 * `npm run dev` script (COBOT_WATCH=1) and propagated to the control script so a
 * Telegram /restart keeps the same launch mode.
 */
export function detectWatchMode(): boolean {
  return process.env.COBOT_WATCH === "1";
}

/**
 * Run a control action through scripts/cobot.sh.
 *
 * Self-lifecycle actions (stop / restart) make the script KILL THIS very
 * process. We therefore spawn it DETACHED and unref it: the child reparents to
 * init and keeps running after the bot is SIGTERM'd, then boots a fresh
 * instance. The caller MUST send any user-facing acknowledgement BEFORE
 * invoking this for stop/restart, because the process will be gone before the
 * child exits. Non-fatal actions (start / install) resolve normally.
 *
 * `scriptPath` defaults to SCRIPT but is overridable for tests. `forceWatch`
 * overrides the inherited mode for this one invocation (e.g. an explicit
 * `/bot restart --watch`); when omitted, the current process's mode is kept.
 * The resolved mode is injected as COBOT_WATCH so the spawned bot inherits it.
 */
export function runBotCtl(
  action: BotCtlAction,
  scriptPath: string = SCRIPT,
  opts: { forceWatch?: boolean } = {},
): Promise<CtlResult> {
  const watch = opts.forceWatch ?? detectWatchMode();
  const env = { ...process.env, COBOT_WATCH: watch ? "1" : "0" };
  return new Promise((resolveResult) => {
    const child = spawn("bash", [scriptPath, action], {
      cwd: ROOT_DIR,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    child.unref();
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("error", (err) =>
      resolveResult({ ok: false, code: null, output: out + `\n[spawn error] ${err.message}` }),
    );
    child.on("exit", (code) => resolveResult({ ok: code === 0, code, output: out }));
  });
}

/** Last `n` lines of the bot log (used by /bot status). */
export function tailBotLog(n = 12, path: string = BOT_LOG): string {
  if (!existsSync(path)) return "(no log file yet)";
  try {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    return lines.slice(-n).join("\n").trim() || "(empty log)";
  } catch {
    return "(cannot read log)";
  }
}
