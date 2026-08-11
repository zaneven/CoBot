import { test } from "node:test";
import assert from "node:assert/strict";
import type { InlineKeyboard, Context } from "grammy";
import { renderProjectsKeyboard, renderApprovalKeyboard, handleApprove, handleApproveModeCallback } from "./commands.js";

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
