import { spawn, type StdioOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, existsSync, openSync, closeSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
// src/bot/ctl.ts → project root is two levels up.
export const ROOT_DIR = resolve(here, "..", "..");
export const SCRIPT = resolve(ROOT_DIR, "scripts", "cobot.sh");
export const BOT_LOG = resolve(ROOT_DIR, "bot.log");
/** Detached control-script output (stop/restart redirect here, not to a pipe). */
export const CTL_LOG = resolve(ROOT_DIR, "data", "ctl.log");

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
  opts: { forceWatch?: boolean; notifyChatId?: number } = {},
): Promise<CtlResult> {
  const watch = opts.forceWatch ?? detectWatchMode();
  const env: NodeJS.ProcessEnv = { ...process.env, COBOT_WATCH: watch ? "1" : "0" };
  // When restarting, carry the originating Telegram chat id into the new
  // instance so it can push a "restart complete" confirmation once it is up
  // (this process will be dead before the restart finishes).
  if (opts.notifyChatId != null) env.COBOT_NOTIFY_CID = String(opts.notifyChatId);
  // stop/restart kill THIS very process. Their detached script must NOT keep
  // stdout/stderr as pipes back to us: once the bot dies the read end closes,
  // and the control script's very next write raises SIGPIPE, killing it mid-
  // restart before it can relaunch the bot. Redirect those actions to a log
  // file instead so the script survives our death and completes the restart.
  // start/install keep the pipe (they don't kill us, and tests assert output).
  const selfKill = action === "stop" || action === "restart";
  return new Promise((resolveResult) => {
    let fd: number | null = null;
    let stdio: StdioOptions;
    if (selfKill) {
      fd = openSync(CTL_LOG, "a");
      stdio = ["ignore", fd, fd];
    } else {
      stdio = ["ignore", "pipe", "pipe"];
    }
    const child = spawn("bash", [scriptPath, action], {
      cwd: ROOT_DIR,
      detached: true,
      stdio,
      env,
    });
    child.unref();
    let out = "";
    if (!selfKill) {
      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    }
    child.on("error", (err) => {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
      resolveResult({ ok: false, code: null, output: out + `\n[spawn error] ${err.message}` });
    });
    child.on("exit", (code) => {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
      resolveResult({ ok: code === 0, code, output: out });
    });
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
