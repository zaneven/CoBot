#!/usr/bin/env npx tsx
/**
 * Interactive CoBot setup — gathers only the essentials needed to start the
 * bot (Telegram bot token + your user id + a dev-root directory) and writes
 * them into `config.yaml` (replacing the template placeholders), leaving every
 * other option at its default. The token & allowed users live in config.yaml,
 * not .env — that's where the bot reads them, so writing them there is what
 * makes a fresh install actually start.
 *
 * Two conditional checks make a fresh install just work:
 *   - admin port: if the configured port is already in use, prompt for a free one
 *   - proxy: probe direct reachability to api.telegram.org; only ask for a
 *     proxy when the direct path is actually blocked (so reachable networks
 *     are never forced to configure a proxy)
 *
 * After writing, the files are re-read and the essentials asserted — a write
 * that silently failed (permissions, wrong path, full disk) aborts loudly here
 * with the absolute paths, instead of printing success and letting `cobot start`
 * fail later with "TELEGRAM_BOT_TOKEN not set".
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
import { get as httpsGet, type Agent } from "node:https";
import { createServer } from "node:net";
import { parseDocument } from "yaml";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

// Resolve the project root. Prefer the current working directory when it looks
// like the repo (has package.json + config.example.yaml) — this matches how the
// bot itself resolves config (src/config.ts keys everything off process.cwd()).
// Fall back to the script file's own location so setup still works when launched
// from elsewhere. Aligning the two prevents a class of "wrote here, reads there"
// silent failures.
function findRootDir(): string {
  const fromCwd = resolve(process.cwd());
  if (existsSync(resolve(fromCwd, "package.json")) && existsSync(resolve(fromCwd, "config.example.yaml"))) {
    return fromCwd;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

const ROOT_DIR = findRootDir();
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
  // Read values as plain JS: parseDocument().get/getIn return YAML *node* objects
  // for containers (YAMLSeq/YAMLMap), so Array.isArray()/indexing on them
  // silently fail (arr[0] → undefined). toJSON() gives the plain JS view needed
  // for pre-filling defaults, while the doc itself (comments preserved) is only
  // needed for the write path.
  const cfg = doc.toJSON() as {
    devRoots?: unknown[];
    telegram?: { botToken?: string; allowedUsers?: unknown[] | unknown };
    admin?: { apiKey?: string };
  };
  cur.devRoot = Array.isArray(cfg.devRoots) ? String(cfg.devRoots[0] ?? "") : "";
  cur.adminApiKey = String(cfg.admin?.apiKey ?? "");
  if (!cur.token) cur.token = String(cfg.telegram?.botToken ?? "");
  if (!cur.users) {
    const allowed = cfg.telegram?.allowedUsers;
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

/** Remove every (active or commented) KEY=... line from .env text. Used to
 *  migrate TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USERS out of .env into
 *  config.yaml so the YAML value is the single source of truth. */
function removeEnvKey(text: string, key: string): string {
  const re = new RegExp(`^\\s*#?\\s*${key}\\s*=`);
  return text.split("\n").filter((line) => !re.test(line)).join("\n");
}

/** Read the ACTIVE (uncommented) value of a KEY=value line from .env text. */
function envActiveValue(text: string, key: string): string {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

/** Test whether a TCP port is free to bind on host. true = free. */
function isPortFree(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      server.close();
      resolve(ok);
    };
    server.once("error", () => finish(false));
    server.listen(port, host, () => finish(true));
    const t = setTimeout(() => finish(false), timeoutMs);
    t.unref?.();
  });
}

/** Scan upward from `start`+1 for the first free port, or 0 if none found. */
async function pickFreePort(host: string, start: number): Promise<number> {
  for (let p = start + 1; p <= start + 100 && p < 65536; p++) {
    if (await isPortFree(host, p)) return p;
  }
  return 0;
}

/** Prompt for a free admin port after the configured one was found occupied. */
async function askFreePort(host: string, occupied: number): Promise<number> {
  for (;;) {
    const raw = (await readLine(`  请输入一个可用端口 [回车=自动选择] (当前 ${occupied} 被占用): `)).trim();
    if (!raw) {
      const picked = await pickFreePort(host, occupied);
      if (picked) {
        console.log(`  ✓ 已自动选择端口 ${picked}`);
        return picked;
      }
      console.log("  ✗ 未能自动找到可用端口，请手动输入");
      continue;
    }
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
      console.log("  ✗ 端口须为 1–65535 的数字");
      continue;
    }
    const p = Number(raw);
    if (await isPortFree(host, p)) {
      console.log(`  ✓ 端口 ${p} 可用`);
      return p;
    }
    console.log(`  ✗ 端口 ${p} 也被占用，请换一个`);
  }
}

/** Build a node-fetch/node-https-compatible proxy agent, or undefined if invalid. */
function makeProxyAgent(proxyUrl: string): Agent | undefined {
  try {
    return proxyUrl.startsWith("socks")
      ? new SocksProxyAgent(proxyUrl)
      : new HttpsProxyAgent(proxyUrl);
  } catch {
    return undefined;
  }
}

/** Probe whether api.telegram.org is reachable. Any HTTP response counts as OK;
 *  timeout/connection error = blocked. When `agent` is given, tests through it. */
function telegramReachable(agent?: Agent, timeoutMs = 7000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpsGet("https://api.telegram.org/", { agent, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

const PROXY_RE = /^(https?|socks[45]h?):\/\/\S+/i;

/** Prompt for a proxy URL and verify Telegram is reachable through it.
 *  Returns "" when the user skips. */
async function askProxy(): Promise<string> {
  for (;;) {
    const raw = (await readLine("  代理地址（如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080，留空跳过）: ")).trim();
    if (!raw) return "";
    if (!PROXY_RE.test(raw)) {
      console.log("  ✗ 格式应为 http://host:port 或 socks5://host:port");
      continue;
    }
    console.log(`  正在通过 ${raw} 测试与 Telegram 的连通…`);
    const agent = makeProxyAgent(raw);
    if (!agent) {
      console.log("  ✗ 无法创建代理客户端，请检查地址");
      continue;
    }
    const ok = await telegramReachable(agent, 10000);
    if (ok) return raw;
    console.log("  ✗ 经该代理仍无法连接 Telegram，请检查代理是否运行或换一个");
  }
}

/** Re-read the written files and assert the essentials actually landed. Throws
 *  a loud error with absolute paths if verification fails — so a silent write
 *  failure aborts here instead of masquerading as success. */
function verifyWritten(expected: { token: string; users: string; devRoot: string; apiKey: string }): void {
  const missing: string[] = [];

  if (!existsSync(CONFIG_PATH)) {
    missing.push(`config.yaml 不存在 (${CONFIG_PATH})`);
  } else {
    const doc = parseDocument(readFileSync(CONFIG_PATH, "utf8"));
    // Plain-JS view: parseDocument().get() returns a YAMLSeq node for sequences,
    // which Array.isArray()/indexing can't inspect (roots[0] would be undefined
    // and the check would throw a false "not written" error). toJSON() reads the
    // real written values back correctly.
    const cfg = doc.toJSON() as {
      telegram?: { botToken?: string; allowedUsers?: unknown[] };
      devRoots?: unknown[];
      admin?: { apiKey?: string; port?: unknown };
    };

    // token: must match what was just written — catches a silent write failure.
    const token = String(cfg.telegram?.botToken ?? "").trim();
    if (!token) missing.push("config.yaml 的 telegram.botToken 为空");
    else if (token !== expected.token) missing.push("config.yaml 的 telegram.botToken 与所填值不一致");

    // allowedUsers: every entered ID must be present in the written list.
    const allowed = cfg.telegram?.allowedUsers;
    const writtenNums = Array.isArray(allowed) ? allowed.map((u: unknown) => Number(u)) : [];
    const enteredNums = expected.users.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
    const usersOk = enteredNums.length > 0 && enteredNums.every((n) => writtenNums.includes(n));
    if (!usersOk) missing.push("config.yaml 的 telegram.allowedUsers 未包含所填用户 ID");

    const rootsOk = Array.isArray(cfg.devRoots) && cfg.devRoots.some((r: unknown) => String(r) === expected.devRoot);
    if (!rootsOk) missing.push("config.yaml 的 devRoots 未包含所填开发根目录");
    const key = String(cfg.admin?.apiKey ?? "").trim();
    if (!key) missing.push("config.yaml 的 admin.apiKey 为空");
    const port = cfg.admin?.port;
    if (port === null || port === undefined) missing.push("config.yaml 的 admin.port 未设置");
  }

  if (missing.length > 0) {
    throw new Error(
      `配置写入校验失败！写入后重读发现以下问题:\n  - ${missing.join("\n  - ")}\n` +
        `已写入的目标路径:\n  config.yaml = ${CONFIG_PATH}\n  .env        = ${ENV_PATH}\n` +
        `请检查该路径的写入权限或磁盘空间，或手动编辑 config.yaml 后再启动。`,
    );
  }
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

  // Default the dev root to the current working directory (i.e. `pwd` — the
  // install directory the user is in). The user can type any other path;
  // Enter accepts this default. Mirrors how the bot resolves config (cwd).
  const defaultRoot = cur.devRoot || process.cwd();
  const devRoot = await ask("3/3  开发根目录（其子目录可用 /bind 绑定）", {
    def: defaultRoot,
    validate: validateDevRoot,
  });

  // ── config.yaml: telegram credentials + devRoots + admin apiKey ──────────
  // Token & allowed users are written into config.yaml (replacing the template
  // placeholders), NOT .env. The bot reads telegram.botToken / allowedUsers
  // from here, so this — not an .env line — is what makes a fresh install start.
  const doc = parseDocument(readFileSync(CONFIG_PATH, "utf8"));
  doc.setIn(["telegram", "botToken"], token);
  const usersArray = users
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
  doc.setIn(["telegram", "allowedUsers"], usersArray);
  doc.setIn(["devRoots"], [devRoot]);

  // Auto-generate a random admin API key only when none is set, so the built-in
  // web admin panel is protected by default without bothering the user.
  let apiKey = String(doc.getIn(["admin", "apiKey"]) ?? "").trim();
  if (!apiKey) {
    apiKey = randomBytes(18).toString("hex");
    doc.setIn(["admin", "apiKey"], apiKey);
  }

  // ── admin port: prompt for a free port if the configured one is in use ───
  const adminEnabled = doc.getIn(["admin", "enabled"]);
  const adminHost = String(doc.getIn(["admin", "host"]) ?? "127.0.0.1");
  let adminPort = Number(doc.getIn(["admin", "port"]) ?? 8085);
  if (adminEnabled !== false && !(await isPortFree(adminHost, adminPort))) {
    console.log(`\n[!] 管理面板端口 ${adminHost}:${adminPort} 已被占用。`);
    adminPort = await askFreePort(adminHost, adminPort);
    doc.setIn(["admin", "port"], adminPort);
  }
  writeFileSync(CONFIG_PATH, doc.toString(), "utf8");

  // ── .env: drop any legacy token/users lines so config.yaml is the single
  //    source of truth. (COBOT_PROXY, if set, stays in .env — handled below.) ─
  if (existsSync(ENV_PATH)) {
    let envText = readFileSync(ENV_PATH, "utf8");
    envText = removeEnvKey(envText, "TELEGRAM_BOT_TOKEN");
    envText = removeEnvKey(envText, "TELEGRAM_ALLOWED_USERS");
    writeFileSync(ENV_PATH, envText, "utf8");
  }

  // ── proxy: only ask if a proxy isn't already configured AND the direct path
  //    to Telegram is actually blocked. Reachable networks skip this entirely.
  const activeProxy = envActiveValue(readFileSync(ENV_PATH, "utf8"), "COBOT_PROXY");
  if (activeProxy) {
    console.log(`\n[+] 已配置代理 (${activeProxy})，跳过连通性检测。`);
  } else {
    console.log("\n[+] 检测与 Telegram (api.telegram.org) 的直连…");
    const directOk = await telegramReachable();
    if (directOk) {
      console.log("✓ 直连 Telegram 正常，无需配置代理。");
    } else {
      console.log("[!] 无法直连 api.telegram.org（超时或被拒），该网络可能需要代理。");
      const proxyUrl = await askProxy();
      if (proxyUrl) {
        envText = readFileSync(ENV_PATH, "utf8");
        envText = setEnvKey(envText, "COBOT_PROXY", proxyUrl);
        writeFileSync(ENV_PATH, envText, "utf8");
        console.log(`✓ 已写入代理并验证可达: ${proxyUrl}`);
      } else {
        console.log("[!] 未配置代理。若启动后 Telegram 不可达，请在 .env 手动设置 COBOT_PROXY。");
      }
    }
  }

  // ── verify: re-read the written files and assert the essentials landed ───
  verifyWritten({ token, users, devRoot, apiKey });

  const adminUrl = adminEnabled === false ? "（管理面板未启用）" : `http://${adminHost}:${adminPort}`;
  console.log("");
  console.log("✓ 配置完成！已写入以下文件:");
  console.log(`  .env        = ${ENV_PATH}`);
  console.log(`  config.yaml = ${CONFIG_PATH}`);
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
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("EOF") || err?.code === "ERR_USE_AFTER_CLOSE") {
      console.log("\n（输入已结束，配置未完成）");
    } else {
      console.error(`\n✗ ${msg}`);
    }
    process.exitCode = 1;
  })
  .finally(() => rl.close());
