import { test } from "node:test";
import assert from "node:assert/strict";
import type { InlineKeyboard, Context } from "grammy";
import { renderProjectsKeyboard, renderApprovalKeyboard, handleApprove, handleApproveModeCallback, handleBot, buildActionKeyboard, renderModelsKeyboard, handleModels, handleModelCallback, renderEngineKeyboard, handleEngine, handleEngineCallback } from "./commands.js";

// grammY's InlineKeyboard instance carries the built grid on `.inline_keyboard`.
type Button = { text?: string; callback_data?: string };
function rows(kb: InlineKeyboard): Button[][] {
  return (kb as unknown as { inline_keyboard: Button[][] }).inline_keyboard.filter((r) => r.length > 0);
}

const mkProjects = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `p${i}`, path: `/p${i}` }));

test("page 0 of 25: 5 grid rows of 2 + nav row (indicator + next, no prev)", () => {
  const r = rows(renderProjectsKeyboard(mkProjects(25), null, 0));
  assert.equal(r.length, 7); // 5 grid + 1 nav + 1 新建
  for (let i = 0; i < 5; i++) assert.equal(r[i]!.length, 2, `grid row ${i} has 2 buttons`);
  const nav = r[5]!;
  assert.equal(nav.length, 2);
  assert.ok(nav.some((b) => b.callback_data === "projpg:1"), "has next button");
  assert.ok(nav.some((b) => b.text === "1/3"), "has page indicator 1/3");
  assert.ok(!nav.some((b) => (b.callback_data ?? "").startsWith("projpg:0")), "no prev on page 0");
  // "新建项目" row at the bottom.
  assert.equal(r[6]![0]!.text, "➕ 新建项目");
});

test("middle page: prev + indicator + next", () => {
  const r = rows(renderProjectsKeyboard(mkProjects(25), null, 1));
  assert.equal(r.length, 7); // 5 grid + 1 nav + 1 新建
  const nav = r[5]!;
  assert.equal(nav.length, 3);
  assert.ok(nav.some((b) => b.callback_data === "projpg:0"), "prev");
  assert.ok(nav.some((b) => b.callback_data === "projpg:2"), "next");
  assert.ok(nav.some((b) => b.text === "2/3"), "indicator 2/3");
});

test("last page: prev + indicator, no next; partial grid row", () => {
  const r = rows(renderProjectsKeyboard(mkProjects(25), null, 2));
  assert.equal(r.length, 5); // 3 grid + 1 nav + 1 新建
  assert.equal(r[2]!.length, 1, "last grid row has the leftover single project");
  const nav = r[3]!;
  assert.equal(nav.length, 2);
  assert.ok(nav.some((b) => b.callback_data === "projpg:1"), "prev");
  assert.ok(!nav.some((b) => (b.callback_data ?? "").startsWith("projpg:3")), "no next on last page");
  assert.ok(nav.some((b) => b.text === "3/3"), "indicator 3/3");
});

test("<=10 projects: no pagination controls at all", () => {
  const r = rows(renderProjectsKeyboard(mkProjects(5), null, 0));
  assert.equal(r.length, 4); // 3 item rows (2+2+1) + 1 新建
  assert.ok(
    !r.some((row) => row.some((b) => (b.callback_data ?? "").startsWith("projp"))),
    "no projpg/projpi buttons when single page",
  );
});

test("current project is marked with ●", () => {
  const projects = mkProjects(25);
  const r = rows(renderProjectsKeyboard(projects, projects[0]!.path, 0));
  assert.equal(r[0]![0]!.text, "● p0");
  assert.equal(r[0]![1]!.text, "p1"); // sibling not marked
});

test("grid buttons select via proj:<name>", () => {
  const r = rows(renderProjectsKeyboard(mkProjects(25), null, 0));
  assert.equal(r[0]![0]!.callback_data, "proj:p0");
  assert.equal(r[4]![1]!.callback_data, "proj:p9");
});

test("page is clamped past the end", () => {
  // 25 projects = 3 pages (0..2); page 99 should clamp to 2 (last).
  const r = rows(renderProjectsKeyboard(mkProjects(25), null, 99));
  // Nav is second-to-last; last row is "新建项目".
  const nav = r[r.length - 2]!;
  assert.ok(nav.some((b) => b.text === "3/3"));
});

test("no trailing empty button row (Telegram rejects empty rows)", () => {
  const raw = (renderProjectsKeyboard(mkProjects(25), null, 0) as unknown as { inline_keyboard: Button[][] })
    .inline_keyboard;
  assert.ok(raw.every((row) => row.length > 0), "every row has at least one button");
});

// ── /approve mode keyboard + toggle ──────────────────────────────────

/** Minimal grammY Context mock that records reply / editMessageText /
 *  answerCallbackQuery calls so we can assert on the bot's output. */
function mkCtx(overrides: Record<string, unknown> = {}) {
  const sent: { text: string; opts?: unknown }[] = [];
  const edited: { text: string; opts?: unknown }[] = [];
  const answered: unknown[] = [];
  const ctx = {
    chat: { id: 123 },
    reply: (text: string, opts?: unknown) => {
      sent.push({ text, opts });
      return Promise.resolve({});
    },
    editMessageText: (text: string, opts?: unknown) => {
      edited.push({ text, opts });
      return Promise.resolve({});
    },
    answerCallbackQuery: (opts?: unknown) => {
      answered.push(opts);
      return Promise.resolve(true);
    },
    ...overrides,
  };
  return { ctx: ctx as unknown as Context, sent, edited, answered };
}

/** In-memory store double that tracks the approval mode and always reports a
 *  bound project (unless `bound` is false). */
function mkStore(initialMode: "auto" | "interactive", bound = true) {
  let mode = initialMode;
  return {
    get mode() {
      return mode;
    },
    getBinding: () => (bound ? { chat_id: 123, project_path: "/x", session_id: null, approval_mode: mode, created_at: 0, updated_at: 0 } : null),
    setApprovalMode: (_id: number, m: "auto" | "interactive") => {
      mode = m;
    },
    listAlwaysAllow: () => [],
    clearAlwaysAllow: () => 0,
  } as unknown as import("../store/db.js").Store & { mode: "auto" | "interactive" };
}

test("renderApprovalKeyboard: current mode highlighted, both wired to approve:<target>", () => {
  const auto = rows(renderApprovalKeyboard("auto"));
  assert.equal(auto.length, 2, "two rows");
  assert.equal(auto[0]![0]!.text, "✅ 自动 (auto)");
  assert.equal(auto[0]![0]!.callback_data, "approve:auto");
  assert.equal(auto[1]![0]!.text, "⚪ 手动 (interactive)");
  assert.equal(auto[1]![0]!.callback_data, "approve:interactive");

  const int = rows(renderApprovalKeyboard("interactive"));
  assert.equal(int[0]![0]!.text, "⚪ 自动 (auto)");
  assert.equal(int[1]![0]!.text, "✅ 手动 (interactive)");
  assert.equal(int[1]![0]!.callback_data, "approve:interactive");
});

test("handleApprove (no arg) replies with status + toggle keyboard", async () => {
  const { ctx, sent } = mkCtx();
  await handleApprove(ctx, mkStore("auto"));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /审批模式/);
  assert.ok((sent[0]!.opts as { reply_markup?: unknown })?.reply_markup, "carries inline keyboard");
});

test("handleApproveModeCallback toggles mode and refreshes keyboard", async () => {
  const store = mkStore("auto");
  const { ctx, edited, answered } = mkCtx({ callbackQuery: { data: "approve:interactive" } });
  await handleApproveModeCallback(ctx, store);
  assert.equal(store.mode, "interactive", "mode persisted");
  assert.equal(edited.length, 1, "message edited with new status");
  assert.match(edited[0]!.text, /手动/);
  assert.ok((edited[0]!.opts as { reply_markup?: unknown })?.reply_markup, "keyboard refreshed");
  assert.equal((answered[0] as { text?: string })?.text, "已切换为 手动");
});

test("handleApproveModeCallback refuses when no project is bound", async () => {
  const store = mkStore("auto", false);
  const { ctx, edited, answered } = mkCtx({ callbackQuery: { data: "approve:interactive" } });
  await handleApproveModeCallback(ctx, store);
  assert.equal(store.mode, "auto", "mode unchanged");
  assert.equal(edited.length, 0, "no edit when unbound");
  assert.equal((answered[0] as { text?: string })?.text, "请先 /projects 选择项目");
});

// ── /bot lifecycle control ──────────────────────────────────────────────

test("/bot with no/invalid arg replies usage", async () => {
  const { ctx, sent } = mkCtx();
  await handleBot(ctx);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /用法/);
  assert.match(sent[0]!.text, /restart/);
});

test("/bot status reports running state as HTML", async () => {
  const { ctx, sent } = mkCtx();
  await handleBot(ctx, "status");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /CoBot 状态/);
  assert.match(sent[0]!.text, /运行状态/);
  assert.equal((sent[0]!.opts as { parse_mode?: string })?.parse_mode, "HTML");
});

test("/bot restart replies an ack without blocking (fire-and-forget)", async () => {
  const { ctx, sent } = mkCtx();
  await handleBot(ctx, "restart");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /正在重启/);
});

test("/bot restart --watch announces hot-reload mode", async () => {
  const { ctx, sent } = mkCtx();
  await handleBot(ctx, "restart --watch");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /正在重启/);
  assert.match(sent[0]!.text, /热重载模式/);
});

test("/bot restart --no-watch announces plain mode", async () => {
  const { ctx, sent } = mkCtx();
  await handleBot(ctx, "restart --no-watch");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /普通模式/);
});

test("/bot status shows hot-reload mode when COBOT_WATCH=1", async () => {
  const prev = process.env.COBOT_WATCH;
  process.env.COBOT_WATCH = "1";
  try {
    const { ctx, sent } = mkCtx();
    await handleBot(ctx, "status");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /启动模式/);
    assert.match(sent[0]!.text, /热重载/);
  } finally {
    if (prev === undefined) delete process.env.COBOT_WATCH;
    else process.env.COBOT_WATCH = prev;
  }
});

// ── Action keyboard (persistent ReplyKeyboardMarkup) ─────────────────

test("buildActionKeyboard renders 2 rows of 3 English buttons without approval", () => {
  const kb = buildActionKeyboard();
  const raw = (kb as unknown as { keyboard: { text: string }[][] }).keyboard;
  assert.equal(raw.length, 2, "must have exactly 2 rows");
  assert.deepEqual(raw[0]!.map((b) => b.text), ["Projects", "Sessions", "New"]);
  assert.deepEqual(raw[1]!.map((b) => b.text), ["Stop", "Queue", "Tasks"]);
  const allTexts = raw.flat().map((b) => b.text);
  assert.ok(!allTexts.includes("审批"), "should not contain 审批");
  assert.ok(!allTexts.includes("Approve"), "should not contain Approve");
});


// ── /models — per-chat model picker ──────────────────────────────────

/** Store double for /models tests: tracks the per-chat model (+ optional
 *  engine override) and reports a bound project unless `bound` is false. */
function mkModelStore(initialModel: string | null = null, bound = true, engine: string | null = null) {
  let model = initialModel;
  return {
    get model() {
      return model;
    },
    getBinding: () =>
      bound
        ? { chatId: 123, projectPath: "/x", sessionId: null, approvalMode: null, model, engine, createdAt: 0, updatedAt: 0 }
        : undefined,
    setModel: (_id: number, m: string | null) => {
      model = m;
    },
  } as unknown as import("../store/db.js").Store & { model: string | null };
}

/** Lister double: returns a fixed pick list and records the engine it was
 *  asked for, so tests can assert the engine-aware dispatch. */
function mkLister(models: string[], error = false) {
  const calls: string[] = [];
  return {
    calls,
    lister: async (_config: unknown, engine: string) => {
      calls.push(engine);
      if (error) throw new Error("boom");
      return { models, note: "stub note" };
    },
  };
}

const MODELS = ["m-one[1M]", "m-two", "org/m-three"];
const CFG = { backend: "claude", claude: { model: undefined, models: MODELS } } as never;

test("renderModelsKeyboard: one row per model + default row, ✅ marks the pick", () => {
  const picked = rows(renderModelsKeyboard(MODELS, "m-two"));
  assert.equal(picked.length, 4, "3 model rows + default row");
  // Short ids are embedded directly in callback_data (not an index).
  assert.equal(picked[0]![0]!.callback_data, "model:m-one[1M]");
  assert.equal(picked[1]![0]!.text, "✅ m-two");
  assert.equal(picked[1]![0]!.callback_data, "model:m-two");
  assert.equal(picked[3]![0]!.text, "⚪ 默认 (跟随配置)");
  assert.equal(picked[3]![0]!.callback_data, "model:__default__");

  const none = rows(renderModelsKeyboard(MODELS, null));
  assert.equal(none[3]![0]!.text, "✅ 默认 (跟随配置)", "default highlighted when no pick");
  const firstBtn = none[0]![0]!;
  assert.ok(!firstBtn.text?.startsWith("✅"), "no model highlighted");
});

test("renderModelsKeyboard with empty list still offers the default button", () => {
  const r = rows(renderModelsKeyboard([], null));
  assert.equal(r.length, 1);
  assert.equal(r[0]![0]!.callback_data, "model:__default__");
});

test("renderModelsKeyboard falls back to index callback_data for very long ids", () => {
  const longId = "x".repeat(70);
  const r = rows(renderModelsKeyboard([longId], null));
  assert.equal(r[0]![0]!.callback_data, "model:i:0", "70-char id cannot fit in 64-byte callback_data");
});

test("handleModels (no arg) replies with status + keyboard for the chat engine", async () => {
  const { lister, calls } = mkLister(MODELS);
  const { ctx, sent } = mkCtx();
  await handleModels(ctx, CFG, mkModelStore(null), lister as never);
  assert.deepEqual(calls, ["claude"], "listes with the chat's engine");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /模型选择/);
  assert.match(sent[0]!.text, /当前引擎: claude/);
  assert.match(sent[0]!.text, /默认（不指定）/);
  assert.ok((sent[0]!.opts as { reply_markup?: unknown })?.reply_markup, "carries inline keyboard");
});

test("handleModels follows the per-chat engine override", async () => {
  const { lister, calls } = mkLister(MODELS);
  const { ctx } = mkCtx();
  await handleModels(ctx, CFG, mkModelStore(null, true, "opencode"), lister as never);
  assert.deepEqual(calls, ["opencode"]);
});

test("handleModels <id> sets the model on the binding", async () => {
  const store = mkModelStore(null);
  const { ctx, sent } = mkCtx({ match: "deepseek-v4-pro[1m]" });
  await handleModels(ctx, CFG, store, mkLister([]).lister as never);
  assert.equal(store.model, "deepseek-v4-pro[1m]", "model persisted");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /deepseek-v4-pro\[1m\]/);
});

test("handleModels off/default clears the pick", async () => {
  const store = mkModelStore("m-two");
  const { ctx, sent } = mkCtx({ match: "off" });
  await handleModels(ctx, CFG, store, mkLister(MODELS).lister as never);
  assert.equal(store.model, null);
  assert.match(sent[0]!.text, /默认（不指定）/);
  const { ctx: ctx2 } = mkCtx({ match: "默认" });
  await handleModels(ctx2, CFG, store, mkLister(MODELS).lister as never);
  assert.equal(store.model, null);
});

test("handleModels <id> without a bound project refuses", async () => {
  const store = mkModelStore(null, false);
  const { ctx, sent } = mkCtx({ match: "m-two" });
  await handleModels(ctx, CFG, store, mkLister(MODELS).lister as never);
  assert.match(sent[0]!.text, /\/projects/);
});

test("handleModelCallback embedded id sets the model, edits status, answers", async () => {
  const store = mkModelStore(null);
  const { ctx, edited, answered } = mkCtx({ callbackQuery: { data: "model:org/m-three" } });
  await handleModelCallback(ctx, CFG, store, mkLister(MODELS).lister as never);
  assert.equal(store.model, "org/m-three", "model persisted");
  assert.equal(edited.length, 1, "status message refreshed");
  assert.match(edited[0]!.text, /org\/m-three/);
  assert.equal((answered[0] as { text?: string })?.text, "已切换为 org/m-three");
});

test("handleModelCallback index form resolves against the refetched list", async () => {
  const store = mkModelStore(null);
  const { ctx, answered } = mkCtx({ callbackQuery: { data: "model:i:2" } });
  await handleModelCallback(ctx, CFG, store, mkLister(MODELS).lister as never);
  assert.equal(store.model, "org/m-three");
  assert.equal((answered[0] as { text?: string })?.text, "已切换为 org/m-three");
});

test("handleModelCallback default clears the pick", async () => {
  const store = mkModelStore("m-two");
  const { ctx, answered } = mkCtx({ callbackQuery: { data: "model:__default__" } });
  await handleModelCallback(ctx, CFG, store, mkLister(MODELS).lister as never);
  assert.equal(store.model, null);
  assert.equal((answered[0] as { text?: string })?.text, "已恢复默认");
});

test("handleModelCallback with a stale index answers gracefully and changes nothing", async () => {
  const store = mkModelStore("m-two");
  const { ctx, edited, answered } = mkCtx({ callbackQuery: { data: "model:i:9" } });
  await handleModelCallback(ctx, CFG, store, mkLister(MODELS).lister as never);
  assert.equal(store.model, "m-two", "model unchanged");
  assert.equal(edited.length, 0, "no edit on stale index");
  assert.equal((answered[0] as { text?: string })?.text, "该选项已失效，请重新 /models");
});

test("handleModelCallback refuses when no project is bound", async () => {
  const store = mkModelStore(null, false);
  const { ctx, answered } = mkCtx({ callbackQuery: { data: "model:m-two" } });
  await handleModelCallback(ctx, CFG, store, mkLister(MODELS).lister as never);
  assert.equal(store.model, null);
  assert.equal((answered[0] as { text?: string })?.text, "请先 /projects 选择项目");
});


// ── /bot lifecycle control ──────────────────────────────────────────────

test("/bot with no/invalid arg replies usage", async () => {
  const { ctx, sent } = mkCtx();
  await handleBot(ctx);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /用法/);
  assert.match(sent[0]!.text, /restart/);
});

test("/bot status reports running state as HTML", async () => {
  const { ctx, sent } = mkCtx();
  await handleBot(ctx, "status");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /CoBot 状态/);
  assert.match(sent[0]!.text, /运行状态/);
  assert.equal((sent[0]!.opts as { parse_mode?: string })?.parse_mode, "HTML");
});

test("/bot restart replies an ack without blocking (fire-and-forget)", async () => {
  const { ctx, sent } = mkCtx();
  await handleBot(ctx, "restart");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /正在重启/);
});

test("/bot restart --watch announces hot-reload mode", async () => {
  const { ctx, sent } = mkCtx();
  await handleBot(ctx, "restart --watch");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /正在重启/);
  assert.match(sent[0]!.text, /热重载模式/);
});

test("/bot restart --no-watch announces plain mode", async () => {
  const { ctx, sent } = mkCtx();
  await handleBot(ctx, "restart --no-watch");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /普通模式/);
});

test("/bot status shows hot-reload mode when COBOT_WATCH=1", async () => {
  const prev = process.env.COBOT_WATCH;
  process.env.COBOT_WATCH = "1";
  try {
    const { ctx, sent } = mkCtx();
    await handleBot(ctx, "status");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /启动模式/);
    assert.match(sent[0]!.text, /热重载/);
  } finally {
    if (prev === undefined) delete process.env.COBOT_WATCH;
    else process.env.COBOT_WATCH = prev;
  }
});

// ── Action keyboard (persistent ReplyKeyboardMarkup) ─────────────────

test("buildActionKeyboard renders 2 rows of 3 English buttons without approval", () => {
  const kb = buildActionKeyboard();
  const raw = (kb as unknown as { keyboard: { text: string }[][] }).keyboard;
  assert.equal(raw.length, 2, "must have exactly 2 rows");
  assert.deepEqual(raw[0]!.map((b) => b.text), ["Projects", "Sessions", "New"]);
  assert.deepEqual(raw[1]!.map((b) => b.text), ["Stop", "Queue", "Tasks"]);
  const allTexts = raw.flat().map((b) => b.text);
  assert.ok(!allTexts.includes("审批"), "should not contain 审批");
  assert.ok(!allTexts.includes("Approve"), "should not contain Approve");
});

// ── /engine — switch backend agent engine ────────────────────────────

test("renderEngineKeyboard marks active engine including agy", () => {
  const rClaude = rows(renderEngineKeyboard("claude", "claude"));
  assert.ok(rClaude[0]![0]!.text?.includes("✅"));
  assert.ok(!rClaude[2]![0]!.text?.includes("✅"));

  const rAGy = rows(renderEngineKeyboard("agy", "claude"));
  assert.ok(!rAGy[0]![0]!.text?.includes("✅"));
  assert.ok(rAGy[2]![0]!.text?.includes("✅ Antigravity CLI"));
  assert.equal(rAGy[2]![0]!.callback_data, "engine:agy");

  const rDefault = rows(renderEngineKeyboard(null, "claude"));
  assert.ok(rDefault[3]![0]!.text?.includes("● 跟随全局默认"));
});

test("handleEngine switches to agy and resets session", async () => {
  let boundEngine: string | null = null;
  let boundSession: string | null = "old-session";
  const store = {
    getBinding: () => ({ projectPath: "/p", engine: boundEngine }),
    setEngine: (_chatId: number, e: any) => { boundEngine = e; },
    setSessionId: (_chatId: number, s: any) => { boundSession = s; },
  };
  const { ctx, sent } = mkCtx({ match: "agy" });
  await handleEngine(ctx, { backend: "claude" } as any, store as any);
  assert.equal(boundEngine, "agy");
  assert.equal(boundSession, null);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /当前驱动引擎: <b>agy<\/b>/);
});

test("handleEngineCallback switches to agy and answers query", async () => {
  let boundEngine: string | null = null;
  let boundSession: string | null = "old-session";
  const store = {
    getBinding: () => ({ projectPath: "/p", engine: boundEngine }),
    setEngine: (_chatId: number, e: any) => { boundEngine = e; },
    setSessionId: (_chatId: number, s: any) => { boundSession = s; },
  };
  let edited = false;
  let answeredText: string | undefined;
  const ctx = {
    chat: { id: 123 },
    callbackQuery: { data: "engine:agy" },
    editMessageText: async () => { edited = true; },
    answerCallbackQuery: async (opts?: { text?: string }) => { answeredText = opts?.text; },
  };
  await handleEngineCallback(ctx as any, { backend: "claude" } as any, store as any);
  assert.equal(boundEngine, "agy");
  assert.equal(boundSession, null);
  assert.equal(edited, true);
  assert.match(answeredText || "", /已切换到 agy/);
});


