#!/usr/bin/env npx tsx
/**
 * Interactive CoBot setup — gathers only the essentials needed to start the
 * bot (Telegram bot token + your user id + a dev-root directory) and writes
 * them into `.env` + `config.yaml`, leaving every other option at its default.
 *
 * Re-run any time: current values are pre-filled, so you can change a single
 * field and press Enter to keep the rest.
 *
 *   via installer:  ./scripts/cobot.sh install
 *   directly:       npx tsx scripts/setup.ts
 */
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { parseDocument } from "yaml";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = resolve(ROOT_DIR, ".env");
const CONFIG_PATH = resolve(ROOT_DIR, "config.yaml");
const CONFIG_EXAMPLE = resolve(ROOT_DIR, "config.example.yaml");
const ENV_EXAMPLE = resolve(ROOT_DIR, ".env.example");

// A minimal line reader with an internal queue. readline/promises' question()
// races when stdin delivers several lines at once (piped input): the later
// 'line' events fire before the next question() registers, get dropped, and
// the awaiting promise never resolves. Buffering lines ourselves makes the
// prompts work both interactively and when fed via a pipe.
const lineQueue: string[] = [];
let pendingResolve: ((line: string) => void) | null = null;
let inputClosed = false;

const rl = createInterface({ input, output, terminal: input.isTTY ?? false });

rl.on("line", (line: string) => {
  if (pendingResolve) {
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(line);
  } else {
    lineQueue.push(line);
  }
});

rl.on("close", () => {
  inputClosed = true;
  if (pendingResolve) {
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve("");
  }
});

/** Prompt and read a single line. Returns "" on EOF. */
async function readLine(prompt: string): Promise<string> {
  output.write(prompt);
  if (lineQueue.length > 0) return lineQueue.shift() as string;
  if (inputClosed) return "";
  return new Promise<string>((resolve) => {
    pendingResolve = resolve;
  });
}

/** Rough but strict-enough Telegram bot token check: <botId>:<35-ish chars>. */
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;

interface Current {
  token: string;
  users: string;
  devRoot: string;
  adminApiKey: string;
}

/** Read existing values so we can pre-fill them as defaults on re-runs. */
function readCurrent(): Current {
  const cur: Current = { token: "", users: "", devRoot: "", adminApiKey: "" };

  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^\s*#?\s*(TELEGRAM_BOT_TOKEN|TELEGRAM_ALLOWED_USERS)\s*=\s*(.*)$/);
      if (m) {
        if (m[1] === "TELEGRAM_BOT_TOKEN") cur.token = m[2].trim();
        if (m[1] === "TELEGRAM_ALLOWED_USERS") cur.users = m[2].trim();
      }
    }
  }

  // config.yaml holds devRoots + admin apiKey, and is also a fallback for the
  // token / allowed users when .env doesn't carry them (e.g. an existing setup
  // that put the token straight in config.yaml).
  const doc = existsSync(CONFIG_PATH) ? parseDocument(readFileSync(CONFIG_PATH, "utf8")) : parseDocument("");
  const roots = doc.get("devRoots");
  if (Array.isArray(roots)) cur.devRoot = String(roots[0] ?? "");
  cur.adminApiKey = String(doc.getIn(["admin", "apiKey"]) ?? "");
  if (!cur.token) cur.token = String(doc.getIn(["telegram", "botToken"]) ?? "");
  if (!cur.users) {
    const allowed = doc.getIn(["telegram", "allowedUsers"]);
    cur.users = Array.isArray(allowed)
      ? allowed.map((u: unknown) => String(u)).join(",")
      : allowed === null || allowed === undefined
        ? ""
        : String(allowed);
  }

  return cur;
}

function validateToken(v: string): string | null {
  if (!v) return "必填：请输入 Telegram Bot Token";
  if (!TOKEN_RE.test(v)) return "格式不对，应为 <数字ID>:<字符>，例如 123456789:ABCdef...";
  return null;
}

function validateUsers(v: string): string | null {
  const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return "必填：至少一个 Telegram 用户 ID";
  for (const p of parts) if (!/^\d{4,}$/.test(p)) return `"${p}" 不是纯数字 ID`;
  return null;
}

function validateDevRoot(v: string): string | null {
  if (!v) return "必填：请输入开发根目录";
  try {
    if (!statSync(v).isDirectory()) return "该路径不是目录";
  } catch {
    return "目录不存在，请检查路径";
  }
  return null;
}

interface AskOpts {
  def?: string;
  hint?: string;
  validate?: (v: string) => string | null;
}

/** Prompt once; Enter accepts the bracketed default. Re-asks on validation error. */
async function ask(question: string, opts: AskOpts = {}): Promise<string> {
  const { def, hint, validate } = opts;
  const tail = hint ? ` (${hint})` : def ? ` [${def}]` : "";
  for (;;) {
    const raw = (await readLine(`${question}${tail}: `)).trim();
    if (!raw && inputClosed) throw new Error("EOF"); // stdin closed mid-prompt
    const val = raw || def || "";
    if (!validate) return val;
    const err = validate(val);
    if (!err) return val;
    console.log(`  ✗ ${err}`);
  }
}

/** Copy config.yaml / .env from their example templates if missing. */
function ensureTemplates(): void {
  if (!existsSync(CONFIG_PATH) && existsSync(CONFIG_EXAMPLE)) {
    writeFileSync(CONFIG_PATH, readFileSync(CONFIG_EXAMPLE, "utf8"));
  }
  if (!existsSync(ENV_PATH) && existsSync(ENV_EXAMPLE)) {
    writeFileSync(ENV_PATH, readFileSync(ENV_EXAMPLE, "utf8"));
  }
}

/** Replace (or append) a single KEY=value line in .env text, preserving others. */
function setEnvKey(text: string, key: string, value: string): string {
  const re = new RegExp(`^\\s*#?\\s*${key}\\s*=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(text)) return text.replace(re, line);
  return `${text.replace(/\n+$/, "")}\n${line}\n`;
}

async function main(): Promise<void> {
  ensureTemplates();

  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  CoBot 交互式配置                             ║");
  console.log("║  只需填写以下必要项，其余保持默认即可启动      ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
  console.log("提示：回车 = 采用方括号内默认值\n");

  const cur = readCurrent();

  const token = await ask("1/3  Telegram Bot Token", {
    def: cur.token,
    hint: cur.token ? "回车保留当前值" : "从 @BotFather 获取",
    validate: validateToken,
  });

  const users = await ask("2/3  你的 Telegram 用户 ID", {
    def: cur.users,
    hint: cur.users ? "回车保留当前值" : "逗号分隔多个，@userinfobot 可查",
    validate: validateUsers,
  });

  const defaultRoot = cur.devRoot || resolve(ROOT_DIR, "..");
  const devRoot = await ask("3/3  开发根目录（其子目录可用 /bind 绑定）", {
    def: defaultRoot,
    validate: validateDevRoot,
  });

  // ── .env: token + allowed users ──────────────────────────────────────────
  let envText = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  envText = setEnvKey(envText, "TELEGRAM_BOT_TOKEN", token);
  envText = setEnvKey(envText, "TELEGRAM_ALLOWED_USERS", users);
  writeFileSync(ENV_PATH, envText, "utf8");

  // ── config.yaml: devRoots + admin apiKey (comments preserved) ─────────────
  const doc = parseDocument(readFileSync(CONFIG_PATH, "utf8"));
  doc.setIn(["devRoots"], [devRoot]);

  // Auto-generate a random admin API key only when none is set, so the built-in
  // web admin panel is protected by default without bothering the user.
  let apiKey = String(doc.getIn(["admin", "apiKey"]) ?? "").trim();
  if (!apiKey) {
    apiKey = randomBytes(18).toString("hex");
    doc.setIn(["admin", "apiKey"], apiKey);
  }
  writeFileSync(CONFIG_PATH, doc.toString(), "utf8");

  const adminEnabled = doc.getIn(["admin", "enabled"]);
  const adminHost = String(doc.getIn(["admin", "host"]) ?? "127.0.0.1");
  const adminPort = String(doc.getIn(["admin", "port"]) ?? "8085");
  const adminUrl = adminEnabled === false ? "（管理面板未启用）" : `http://${adminHost}:${adminPort}`;

  console.log("");
  console.log("✓ 配置完成！已写入 .env 与 config.yaml");
  console.log("");
  console.log(`  Telegram Bot Token : 已配置`);
  console.log(`  允许的用户 ID       : ${users}`);
  console.log(`  开发根目录           : ${devRoot}`);
  console.log(`  管理面板密钥         : ${apiKey}`);
  console.log(`  管理面板地址         : ${adminUrl}`);
  console.log("");
  console.log("下一步：运行  cobot start  启动机器人");
  console.log("");
}

main()
  .catch((err: NodeJS.ErrnoException) => {
    if (err?.message?.includes("EOF") || err?.code === "ERR_USE_AFTER_CLOSE") {
      console.log("\n（输入已结束，配置未完成）");
    } else {
      console.error("\n配置已取消:", err?.message ?? err);
    }
    process.exitCode = 1;
  })
  .finally(() => rl.close());
