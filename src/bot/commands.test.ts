import { test } from "node:test";
import assert from "node:assert/strict";
import type { InlineKeyboard } from "grammy";
import { renderProjectsKeyboard } from "./commands.js";

// grammY's InlineKeyboard instance carries the built grid on `.inline_keyboard`.
type Button = { text?: string; callback_data?: string };
function rows(kb: InlineKeyboard): Button[][] {
  return (kb as unknown as { inline_keyboard: Button[][] }).inline_keyboard.filter((r) => r.length > 0);
}

const mkProjects = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `p${i}`, path: `/p${i}` }));

test("page 0 of 25: 5 grid rows of 2 + nav row (indicator + next, no prev)", () => {
  const r = rows(renderProjectsKeyboard(mkProjects(25), null, 0));
  assert.equal(r.length, 6); // 5 grid rows + 1 nav row
  for (let i = 0; i < 5; i++) assert.equal(r[i]!.length, 2, `grid row ${i} has 2 buttons`);
  const nav = r[5]!;
  assert.equal(nav.length, 2);
  assert.ok(nav.some((b) => b.callback_data === "projpg:1"), "has next button");
  assert.ok(nav.some((b) => b.text === "1/3"), "has page indicator 1/3");
  assert.ok(!nav.some((b) => (b.callback_data ?? "").startsWith("projpg:0")), "no prev on page 0");
});

test("middle page: prev + indicator + next", () => {
  const r = rows(renderProjectsKeyboard(mkProjects(25), null, 1));
  const nav = r[r.length - 1]!;
  assert.equal(nav.length, 3);
  assert.ok(nav.some((b) => b.callback_data === "projpg:0"), "prev");
  assert.ok(nav.some((b) => b.callback_data === "projpg:2"), "next");
  assert.ok(nav.some((b) => b.text === "2/3"), "indicator 2/3");
});

test("last page: prev + indicator, no next; partial grid row", () => {
  const r = rows(renderProjectsKeyboard(mkProjects(25), null, 2));
  assert.equal(r.length, 4); // 3 grid rows (5 items: 2+2+1) + nav
  assert.equal(r[2]!.length, 1, "last grid row has the leftover single project");
  const nav = r[r.length - 1]!;
  assert.equal(nav.length, 2);
  assert.ok(nav.some((b) => b.callback_data === "projpg:1"), "prev");
  assert.ok(!nav.some((b) => (b.callback_data ?? "").startsWith("projpg:3")), "no next on last page");
  assert.ok(nav.some((b) => b.text === "3/3"), "indicator 3/3");
});

test("<=10 projects: no pagination controls at all", () => {
  const r = rows(renderProjectsKeyboard(mkProjects(5), null, 0));
  assert.equal(r.length, 3); // 2 + 2 + 1
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
  const nav = r[r.length - 1]!;
  assert.ok(nav.some((b) => b.text === "3/3"));
});

test("no trailing empty button row (Telegram rejects empty rows)", () => {
  const raw = (renderProjectsKeyboard(mkProjects(25), null, 0) as unknown as { inline_keyboard: Button[][] })
    .inline_keyboard;
  assert.ok(raw.every((row) => row.length > 0), "every row has at least one button");
});
