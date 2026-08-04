import { InlineKeyboard, Keyboard, type Context } from "grammy";
import type { Config } from "../config.js";
import { isPathAllowed, listDevProjects, type DevProject } from "../config.js";
import type { Store } from "../store/db.js";
import type { Registry } from "../registry/registry.js";
import type { CronManager } from "../scheduler/cron.js";
import { listProjectSessions, listAllSessions, findSession } from "../claude/sessions.js";
import { submitInteractive } from "./runs.js";
import { logger } from "../util/logger.js";

/** Single source of truth for the bot's commands. Drives both the Telegram
 *  command menu (setMyCommands) and the /help text so they stay in sync. */
export interface BotCommandDef {
  command: string;
  usage: string; // shown in /help, e.g. "/project <name>"
  description: string; // shown in the Telegram menu and /help
}

export const BOT_COMMANDS: readonly BotCommandDef[] = [
  { command: "projects", usage: "/projects", description: "list dev-root projects (tap to switch)" },
  { command: "project", usage: "/project <name>", description: "switch active project by name" },
  { command: "bind", usage: "/bind <path>", description: "bind to an explicit path" },
  { command: "unbind", usage: "/unbind", description: "unbind this chat from its project" },
  { command: "new", usage: "/new", description: "start a fresh session" },
  { command: "auto", usage: "/auto [off]", description: "persistent auto session mode" },
  { command: "sessions", usage: "/sessions [all]", description: "list Claude Code sessions (tap to switch)" },
  { command: "switch", usage: "/switch <id>", description: "switch the active session by id" },
  { command: "stop", usage: "/stop", description: "interrupt the running task" },
  { command: "tasks", usage: "/tasks", description: "active + recent tasks" },
  { command: "queue", usage: "/queue", description: "show queued prompts" },
  { command: "drop", usage: "/drop", description: "clear queued prompts" },
  { command: "cron", usage: "/cron <5-field cron> | <prompt>", description: "schedule a task" },
  { command: "context", usage: "/context", description: "last turn's context window usage"},
  { command: "skills", usage: "/skills", description: "browse and select skills" },
  { command: "help", usage: "/help", description: "show this help" },
];

const HELP =
  "CoBot - drive Claude Code from Telegram.\n\n" +
  BOT_COMMANDS.map((c) => `${c.usage} - ${c.description}`).join("\n") +
  "\n/cron list · /cron rm <id>\n" +
  "<text> - send a prompt to Claude Code (streams the reply)\n\n" +
  "First time: /projects";

function projectList(config: Config): string {
  const explicit = config.projects.length ? config.projects.map((p) => `• ${p}`).join("\n") : "(none)";
  const roots = config.devRoots.length ? config.devRoots.map((p) => `• ${p}/`).join("\n") : "(none)";
  return `Dev roots:\n${roots}\nExplicit:\n${explicit}`;
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(HELP, { reply_markup: buildActionKeyboard() });
}

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(HELP, { reply_markup: buildActionKeyboard() });
}

// ── ReplyKeyboardMarkup — persistent quick-access bar ──────────────────

/** Build the persistent keyboard that sits above the text-input bar.
 *  Buttons show Chinese labels; each maps to a flat keyword that is
 *  routed via `bot.hears(...)` in bot.ts. */
function buildActionKeyboard(): Keyboard {
  return Keyboard.from([
    ["项目", "会话", "新建"],
    ["停止", "队列", "任务"],
  ]).resized();
}

/** Grid layout for /projects: 5 rows × 2 columns = 10 per page. Pagination
 *  controls appear only when there is more than one page (i.e. > 10 projects). */
const PROJECTS_COLS = 2;
const PROJECTS_ROWS = 5;
const PROJECTS_PAGE_SIZE = PROJECTS_COLS * PROJECTS_ROWS;
/** Inline-button callback prefixes for /projects. `proj:` selects a project;
 *  `projpg:<page>` navigates pages (edits the keyboard); `projpi:<page>` is the
 *  page indicator (no-op, just answers the callback query - avoids a needless
 *  edit that Telegram would reject as "message is not modified"). */
const PROJPG_PREFIX = "projpg:";
const PROJPI_PREFIX = "projpi:";

function parsePage(s: string): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Build the paginated inline keyboard for /projects. */
export function renderProjectsKeyboard(projects: DevProject[], current: string | null, page: number): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(projects.length / PROJECTS_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * PROJECTS_PAGE_SIZE;
  const slice = projects.slice(start, start + PROJECTS_PAGE_SIZE);

  // Build the grid as a 2D button array and construct the keyboard from it, so
  // we never emit a trailing empty button row (the `.text().row()` builder
  // pattern leaves a trailing [] that Telegram rejects).
  type Btn = ReturnType<typeof InlineKeyboard.text>;
  const rows: Btn[][] = [];
  for (let i = 0; i < slice.length; i += PROJECTS_COLS) {
    rows.push(
      slice.slice(i, i + PROJECTS_COLS).map((p) =>
        InlineKeyboard.text(`${p.path === current ? "● " : ""}${p.name}`, `proj:${p.name}`),
      ),
    );
  }

  // Prev / page-indicator / Next row, only when paginating.
  if (totalPages > 1) {
    const nav: Btn[] = [];
    if (safePage > 0) nav.push(InlineKeyboard.text("⬅️", `${PROJPG_PREFIX}${safePage - 1}`));
    nav.push(InlineKeyboard.text(`${safePage + 1}/${totalPages}`, `${PROJPI_PREFIX}${safePage}`));
    if (safePage < totalPages - 1) nav.push(InlineKeyboard.text("➡️", `${PROJPG_PREFIX}${safePage + 1}`));
    rows.push(nav);
  }
  return new InlineKeyboard(rows);
}

/** /projects - list switchable projects under dev roots as inline buttons,
 *  paginated 5×2 with prev/next when there are more than 10. */
export async function handleProjects(ctx: Context, config: Config, store: Store): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const projects = listDevProjects(config);
  if (!projects.length) {
    await ctx.reply("No dev roots configured. Set `devRoots` in config.yaml (e.g. /Users/a1/Develop).");
    return;
  }
  const b = store.getBinding(chatId);
  const current = b?.projectPath ?? null;
  await ctx.reply("Projects (tap to switch):", { reply_markup: renderProjectsKeyboard(projects, current, 0) });
}

/** /project <name> - switch active project by name (basename under a dev root). */
export async function handleProject(ctx: Context, config: Config, store: Store): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const name = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!name) {
    await ctx.reply("Usage: /project <name>\nList with /projects");
    return;
  }
  await switchProject(ctx, config, store, chatId, name);
}

/** Callback for inline `proj:<name>` buttons from /projects. */
export async function handleProjectCallback(ctx: Context, config: Config, store: Store): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("proj:")) return;
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const name = data.slice(5);
  await switchProject(ctx, config, store, chatId, name);
  // Refresh the keyboard so the ● moves to the newly-selected project (stay on
  // the page containing it, which is the one the user just tapped).
  const projects = listDevProjects(config);
  const idx = projects.findIndex((p) => p.name === name || p.name.toLowerCase() === name.toLowerCase());
  const page = idx >= 0 ? Math.floor(idx / PROJECTS_PAGE_SIZE) : 0;
  const current = store.getBinding(chatId)?.projectPath ?? null;
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: renderProjectsKeyboard(projects, current, page) });
  } catch (err) {
    logger.debug({ err: String(err) }, "projects select refresh failed");
  }
  await ctx.answerCallbackQuery({ text: "switched project" });
}

/** Callback for inline `projpg:<page>` (prev/next) and `projpi:<page>` (page
 *  indicator) pagination buttons from /projects. */
export async function handleProjectPageCallback(ctx: Context, config: Config, store: Store): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  if (!data.startsWith(PROJPG_PREFIX) && !data.startsWith(PROJPI_PREFIX)) return;

  const projects = listDevProjects(config);
  const totalPages = Math.max(1, Math.ceil(projects.length / PROJECTS_PAGE_SIZE));
  const b = store.getBinding(chatId);
  const current = b?.projectPath ?? null;

  // Page indicator: no navigation, just acknowledge (avoids a redundant edit).
  if (data.startsWith(PROJPI_PREFIX)) {
    const p = Math.min(parsePage(data.slice(PROJPI_PREFIX.length)), totalPages - 1);
    await ctx.answerCallbackQuery({ text: `Page ${p + 1} / ${totalPages}` });
    return;
  }

  const page = Math.min(parsePage(data.slice(PROJPG_PREFIX.length)), totalPages - 1);
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: renderProjectsKeyboard(projects, current, page) });
  } catch (err) {
    // message too old / deleted - can't swap the keyboard, but still ack the tap
    // so the user doesn't sit on a spinning loader.
    logger.debug({ err: String(err) }, "projects page nav edit failed");
  }
  await ctx.answerCallbackQuery({});
}

async function switchProject(ctx: Context, config: Config, store: Store, chatId: number, name: string): Promise<void> {
  const projects = listDevProjects(config);
  const found =
    projects.find((p) => p.name === name) ?? projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!found) {
    await ctx.reply(`❌ Project not found: ${name}\nUse /projects to list.`);
    return;
  }
  // Switching cwd -> fresh session (the old session belongs to the previous project).
  store.upsertBinding(chatId, found.path, null);
  await ctx.reply(`📁 Project: ${found.name}\n${found.path}\nSession: fresh. Send a message (or /sessions to resume).`, {
    reply_markup: buildActionKeyboard(),
  });
}

export async function handleBind(ctx: Context, config: Config, store: Store): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const arg = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!arg) {
    await ctx.reply(`Usage: /bind <path>\n\n${projectList(config)}`);
    return;
  }
  if (!isPathAllowed(config, arg)) {
    await ctx.reply(`❌ Not allowed.\n\n${projectList(config)}`);
    return;
  }
  store.upsertBinding(chatId, arg, null);
  await ctx.reply(`✅ Bound to ${arg}\nSession: fresh. Send a message to start.`, {
    reply_markup: buildActionKeyboard(),
  });
}

export async function handleUnbind(ctx: Context, store: Store): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  store.clearBinding(chatId);
  await ctx.reply("🔓 Unbound. Use /projects or /bind to bind a project again.", {
    reply_markup: { remove_keyboard: true },
  });
}

export async function handleNew(ctx: Context, store: Store): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const b = store.getBinding(chatId);
  if (!b) {
    await ctx.reply("Pick a project first: /projects");
    return;
  }
  store.setSessionId(chatId, null);
  await ctx.reply(`🆕 Fresh session for ${b.projectPath}. Send your message.`, {
    reply_markup: buildActionKeyboard(),
  });
}

export async function handleStop(ctx: Context, registry: Registry): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const dropped = registry.dropQueue(chatId);
  if (registry.stop(chatId))
    await ctx.reply(`⏹ Interrupting current task${dropped ? ` · dropped ${dropped} queued` : ""}…`);
  else if (dropped) await ctx.reply(`🗑 Dropped ${dropped} queued prompt${dropped > 1 ? "s" : ""}.`);
  else await ctx.reply("Nothing is running.");
}

/** /queue - show the running task + queued prompts. */
export async function handleQueue(ctx: Context, registry: Registry): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const active = registry.get(chatId);
  const items = registry.queuedItems(chatId);
  if (!active && items.length === 0) {
    await ctx.reply("Queue is empty.");
    return;
  }
  const lines: string[] = [];
  if (active) lines.push(`▶️ running: ${truncate(active.displayText, 60)}`);
  items.forEach((it, i) => lines.push(`${i + 1}. ${truncate(it.displayText, 60)}`));
  await ctx.reply(lines.join("\n"));
}

/** /drop - clear queued prompts (the running task keeps going; use /stop for that). */
export async function handleDrop(ctx: Context, registry: Registry): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const n = registry.dropQueue(chatId);
  await ctx.reply(n ? `🗑 Dropped ${n} queued prompt${n > 1 ? "s" : ""}.` : "Queue is already empty.");
}

export async function handleTasks(ctx: Context, store: Store, registry: Registry): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const binding = store.getBinding(chatId);
  const projectPath = binding?.projectPath;
  const active = registry.activeRuns().filter((r) => r.chatId === chatId && (!projectPath || r.projectPath === projectPath));
  const recent = store.listTasksByProject(chatId, projectPath).slice(0, 10);
  const emoji: Record<string, string> = { running: "▶️", done: "✅", aborted: "⏹", error: "❌" };
  const lines: string[] = [];
  if (!projectPath) {
    lines.push("⚠️ No project bound. Use /projects to pick one.");
  }
  if (active.length) {
    lines.push(`Active (${projectPath ? projectPath.split("/").pop() : "all"}):`);
    for (const r of active) {
      lines.push(`▶️ ${r.sessionId ? r.sessionId.slice(0, 8) : "fresh"} · ${relTime(r.startedAt)}`);
    }
  }
  if (recent.length) {
    lines.push(`Recent${projectPath ? ` (${projectPath.split("/").pop()})` : ""}:`);
    for (const t of recent) {
      const projLabel = projectPath ? "" : ` · ${t.projectPath.split("/").pop()}`;
      lines.push(`${emoji[t.status] ?? "•"} ${t.status} · ${truncate(t.prompt, 50)}${projLabel} · ${relTime(t.startedAt)}`);
    }
  }
  if (!active.length && !recent.length) {
    lines.push("No tasks yet.");
  }
  await ctx.reply(lines.join("\n"));
}

export async function handleText(ctx: Context, config: Config, store: Store, registry: Registry): Promise<void> {
  const chatId = ctx.chat?.id;
  const text = ctx.message?.text;
  if (!chatId || !text) return;

  const binding = store.getBinding(chatId);
  if (!binding) {
    await ctx.reply("No project selected. Use /projects to pick one.");
    return;
  }
  // Non-blocking: runs now if idle, else enqueues. grammY's update loop isn't
  // held, so /stop and /queue stay responsive while a task streams.
  submitInteractive({ api: ctx.api, chatId, prompt: { text }, displayText: text, config, registry, store });
}

/**
 * /sessions [all] - list Claude Code sessions for the bound project (or across
 * all projects with `all`), as inline buttons. Tapping a button switches to it.
 */
export async function handleSessions(ctx: Context, store: Store): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const b = store.getBinding(chatId);
  const wantAll = (typeof ctx.match === "string" ? ctx.match.trim() : "") === "all";
  if (!b && !wantAll) {
    await ctx.reply("Pick a project first: /projects\n(or use /sessions all)");
    return;
  }
  const sessions = wantAll ? await listAllSessions(20) : await listProjectSessions(b!.projectPath, 20);
  if (!sessions.length) {
    await ctx.reply(wantAll ? "No sessions found." : `No sessions found for ${b!.projectPath}`);
    return;
  }
  const current = b?.sessionId ?? null;
  const kb = new InlineKeyboard();
  for (const s of sessions) {
    const mark = s.sessionId === current ? "● " : "";
    const label = `${mark}${truncate(s.summary, 28)} · ${relTime(s.lastModified)}`;
    kb.text(label, `sw:${s.sessionId}`).row();
  }
  await ctx.reply(`${wantAll ? "All sessions" : `Sessions in ${b!.projectPath}`} (tap to switch):`, {
    reply_markup: kb,
  });
}

/** /switch <session-id> - switch the chat's active session by id. */
export async function handleSwitch(ctx: Context, store: Store): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const arg = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (!arg) {
    await ctx.reply("Usage: /switch <session-id>\nList with /sessions");
    return;
  }
  await switchTo(ctx, store, chatId, arg);
}

/** Callback handler for inline `sw:<sessionId>` buttons from /sessions. */
export async function handleSwitchCallback(ctx: Context, store: Store): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("sw:")) return;
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const id = data.slice(3);
  await switchTo(ctx, store, chatId, id);
  await ctx.answerCallbackQuery({ text: "switched" });
}

async function switchTo(ctx: Context, store: Store, chatId: number, sessionId: string): Promise<void> {
  const info = await findSession(sessionId);
  if (!info) {
    await ctx.reply(`❌ Session not found: ${sessionId}`);
    return;
  }
  const b = store.getBinding(chatId);
  if (!b) {
    await ctx.reply("Pick a project first: /projects");
    return;
  }
  store.setSessionId(chatId, sessionId);
  await ctx.reply(`🔁 Switched to ${sessionId.slice(0, 8)}…\n${truncate(info.summary, 200)}`, {
    reply_markup: buildActionKeyboard(),
  });
}

/** /cron - manage scheduled Claude Code tasks. */
export async function handleCron(ctx: Context, store: Store, cron: CronManager): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const match = typeof ctx.match === "string" ? ctx.match.trim() : "";

  if (!match || match === "list") {
    const jobs = cron.list(chatId);
    if (!jobs.length) {
      await ctx.reply("No cron jobs.\nUsage: /cron <5-field cron> | <prompt>");
      return;
    }
    const lines = jobs.map((j) => {
      const last = j.lastRunAt ? relTime(j.lastRunAt) : "never";
      const state = j.enabled ? "" : "[disabled] ";
      return `${state}${j.id.slice(0, 8)} · ${j.schedule} · ${truncate(j.prompt, 40)} · last: ${last}`;
    });
    await ctx.reply(lines.join("\n"));
    return;
  }

  if (match.startsWith("rm ")) {
    const id = match.slice(3).trim();
    await ctx.reply(cron.remove(chatId, id) ? `🗑 Removed ${id.slice(0, 8)}` : "Not found");
    return;
  }

  if (match.startsWith("enable ")) {
    const id = match.slice(7).trim();
    await ctx.reply(cron.enable(id) ? `✅ Cron ${id.slice(0, 8)} re-enabled.` : "Not found");
    return;
  }

  if (match.startsWith("disable ")) {
    const id = match.slice(8).trim();
    await ctx.reply(cron.disable(id) ? `⏸ Cron ${id.slice(0, 8)} disabled.` : "Not found");
    return;
  }

  const b = store.getBinding(chatId);
  if (!b) {
    await ctx.reply("Pick a project first: /projects");
    return;
  }
  const sep = match.indexOf("|");
  if (sep < 0) {
    await ctx.reply("Usage: /cron <5-field cron> | <prompt>\nAlso: /cron list, /cron rm <id>");
    return;
  }
  const schedule = match.slice(0, sep).trim();
  const prompt = match.slice(sep + 1).trim();
  if (!cron.validate(schedule)) {
    await ctx.reply(`❌ Invalid cron schedule: ${schedule}`);
    return;
  }
  if (!prompt) {
    await ctx.reply("❌ Empty prompt.");
    return;
  }
  const job = cron.add(chatId, b.projectPath, schedule, prompt);
  logger.info({ chatId, jobId: job.id, schedule }, "cron job added");
  await ctx.reply(`✅ Scheduled (${job.id.slice(0, 8)})\n${schedule}\n${truncate(prompt, 120)}`);
}

/** /context — show the last turn's context-window usage %. Reads from the
 *  in‑memory registry (set on each completed task), so it is reset on restart. */
export async function handleContext(ctx: Context, registry: Registry): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const pct = registry.getContextUsage(chatId);
  if (pct === undefined) {
    await ctx.reply("No context usage yet. Run a task first.");
    return;
  }
  const bar = contextBar(pct);
  await ctx.reply(`📊 Context: ${pct}%\n${bar}`);
}

/** Build a segmented bar: 10 blocks, filled proportionally. */
function contextBar(pct: number): string {
  const n = Math.round(Math.min(pct, 100) / 10);
  return "█".repeat(n) + "░".repeat(10 - n) + ` ${pct}%`;
}

/** Skill definition: name + short description. Descriptions are read from the
 *  YAML frontmatter of ~/.claude/skills/<name>/SKILL.md at bot startup. */
export interface SkillDef {
  name: string;
  desc: string;
  category: string;
}

/** Skill registry, grouped by category for the /skills keyboard. Section order
 *  controls the split point in the paginated grid. */
const SKILLS: readonly SkillDef[] = [
  // ── arkcli — volcengine ARK platform ──
  { name: "arkcli-chat", desc: "对话/推理 · 多模态, 流式, reasoning", category: "arkcli" },
  { name: "arkcli-gen", desc: "图片/视频生成 · seedream/seedance", category: "arkcli" },
  { name: "arkcli-understand", desc: "多模态理解 · OCR, ASR, 视频总结, 字幕", category: "arkcli" },
  { name: "arkcli-deploy", desc: "创建推理接入点 (Endpoint)", category: "arkcli" },
  { name: "arkcli-models", desc: "查询公共基础模型", category: "arkcli" },
  { name: "arkcli-custommodel", desc: "自定义模型仓库管理", category: "arkcli" },
  { name: "arkcli-train-finetune", desc: "模型精调训练", category: "arkcli" },
  { name: "arkcli-onboard", desc: "端到端接入向导", category: "arkcli" },
  { name: "arkcli-doctor", desc: "诊断 · 报错,资源,配额,指标", category: "arkcli" },
  { name: "arkcli-usage", desc: "用量查询 · Token / 请求数", category: "arkcli" },
  { name: "arkcli-billing", desc: "拆分账单 · 结算金额", category: "arkcli" },
  { name: "arkcli-pricing", desc: "模型单价 (含折扣)", category: "arkcli" },
  { name: "arkcli-plans", desc: "套餐管理 · API Key · 席位", category: "arkcli" },
  { name: "arkcli-profile", desc: "profile 切面管理", category: "arkcli" },
  { name: "arkcli-resources", desc: "看接入点/模型资源", category: "arkcli" },
  { name: "arkcli-auth", desc: "认证管理 · 登录, API Key", category: "arkcli" },
  { name: "arkcli-config", desc: "本地配置", category: "arkcli" },
  { name: "arkcli-connect", desc: "安装 skills 到本机 AI Agent", category: "arkcli" },
  { name: "arkcli-helper", desc: "配 AI Agent / MCP / 豆包搜索", category: "arkcli" },
  { name: "arkcli-managed-agent", desc: "ARK Managed Agent", category: "arkcli" },
  { name: "arkcli-infer-endpoint", desc: "已建端点管理 · 启停/更新", category: "arkcli" },
  { name: "arkcli-api-explorer", desc: "Raw API 兜底", category: "arkcli" },
  { name: "arkcli-code-example", desc: "生成 SDK/curl 调用示例", category: "arkcli" },

  // ── search ──
  { name: "byted-web-search", desc: "豆包搜索 · 联网搜索/网页/图片", category: "搜索" },

  // ── tools ──
  { name: "dataviz", desc: "图表/dashboard 可视化", category: "工具" },
  { name: "review", desc: "代码审查 (PR or diff)", category: "工具" },
  { name: "simplify", desc: "代码简化/重构", category: "工具" },

  // ── config ──
  { name: "claude-api", desc: "Claude API / SDK 参考", category: "API" },

  // ── CoBot agents ──
  { name: "cobot-architect", desc: "CoBot 架构设计", category: "CoBot" },
  { name: "cobot-debug", desc: "CoBot 故障排查", category: "CoBot" },
  { name: "cobot-review", desc: "CoBot 代码审查", category: "CoBot" },
];

// Group skills by category: each block has a header row + one row per skill

const SKILLS_PER_PAGE = 12;
const SKILL_PAGE_CB = "skp:";

/** /skills — paginated inline keyboard where each button opens the skill in an
 *  inline query (switchInlineCurrent). The bot's inline_query handler echoes
 *  the text; the user picks a skill, types their request and sends. */
export async function handleSkills(ctx: Context, page = 0): Promise<void> {
  const totalPages = Math.max(1, Math.ceil(SKILLS.length / SKILLS_PER_PAGE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const pageSkills = SKILLS.slice(safePage * SKILLS_PER_PAGE, (safePage + 1) * SKILLS_PER_PAGE);

  const kb = new InlineKeyboard();
  for (const s of pageSkills) {
    kb.switchInlineCurrent(`${s.name} — ${s.desc}`, s.name).row();
  }

  // Pagination row
  if (totalPages > 1) {
    const row = [];
    for (let p = 0; p < totalPages; p++) {
      row.push(InlineKeyboard.text(`${p + 1}`, `${SKILL_PAGE_CB}${p}`));
    }
    kb.row(...row);
  }

  await ctx.reply(
    `Skills (page ${safePage + 1}/${totalPages}): tap a skill to fill the input bar, then type your query.`,
    { reply_markup: kb },
  );
}

/** /auto [off] — toggle persistent auto‑session mode. Stays active until /auto off or restart. */
export async function handleAuto(ctx: Context, config: Config, store: Store, registry: Registry): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const match = (typeof ctx.match === "string" ? ctx.match.trim() : "").toLowerCase();

  if (match === "off") {
    registry.setAuto(chatId, false);
    await ctx.reply("🤖 Auto mode off. The session is still active — /new to reset.", {
      reply_markup: buildActionKeyboard(),
    });
    return;
  }

  const b = store.getBinding(chatId);
  if (!b) {
    await ctx.reply("Pick a project first: /projects");
    return;
  }
  registry.setAuto(chatId, true);
  // Fresh session for the auto session.
  store.setSessionId(chatId, null);
  await ctx.reply(`🤖 Auto mode ON — session stays live.\nProject: ${b.projectPath}\nSend a message to start.`, {
    reply_markup: buildActionKeyboard(),
  });
}
