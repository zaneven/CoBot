import { test } from "node:test";
import assert from "node:assert/strict";
import type { InlineKeyboard } from "grammy";
import { generateSuggestions, registerSuggestion, consumeSuggestion, renderSuggestionKeyboard, type SuggestedAction } from "./nextActions.js";

type Button = { text?: string; callback_data?: string };
function rows(kb: InlineKeyboard): Button[][] {
  return (kb as unknown as { inline_keyboard: Button[][] }).inline_keyboard.filter((r) => r.length > 0);
}

// ── generateSuggestions: heuristic intent recognition ──────────────────────

test("generateSuggestions: empty input yields universal follow-ups only", () => {
  const s = generateSuggestions("");
  assert.ok(s.length >= 2, "always offers universal follow-ups");
  assert.ok(s.some((a) => a.label.includes("继续")), "has 继续深入");
  assert.ok(s.some((a) => a.label.includes("总结")), "has 总结要点");
  // No duplicate prompts.
  assert.equal(new Set(s.map((a) => a.prompt)).size, s.length);
});

test("generateSuggestions: error language → troubleshoot + retry", () => {
  const s = generateSuggestions("Build failed with an error: null reference exception in main.ts");
  assert.ok(s.some((a) => a.label.includes("排查")), "offers 排查错误");
  assert.ok(s.some((a) => a.label.includes("重试")), "offers 重试");
});

test("generateSuggestions: test output → run / fix tests", () => {
  const s = generateSuggestions("3 tests passed, 1 failed. ✗ should render markdown");
  assert.ok(s.some((a) => a.label.includes("运行测试")), "offers 运行测试");
  assert.ok(s.some((a) => a.label.includes("修复失败")), "offers 修复失败的测试");
});

test("generateSuggestions: file paths → open / edit buttons", () => {
  const s = generateSuggestions("I updated ./src/bot/runs.ts and /Users/a1/Develop/CoBot/README.md");
  const labels = s.map((a) => a.label).join(" | ");
  assert.ok(labels.includes("runs.ts"), "open button mentions the filename");
  assert.ok(labels.includes("README.md"), "edit button mentions the filename");
  assert.ok(s.some((a) => a.label.includes("打开")), "has 打开 button");
  assert.ok(s.some((a) => a.label.includes("编辑")), "has 编辑 button");
});

test("generateSuggestions: shell hints → run commands", () => {
  const s = generateSuggestions("Run `npm run build` then `pnpm test` to verify.");
  assert.ok(s.some((a) => a.label.includes("运行")), "offers 运行相关命令");
});

test("generateSuggestions: respects the max cap and de-duplicates", () => {
  // Error + test + two files + shell all fire at once → should be capped.
  const big =
    "error failed test ✗ ./a.ts ./b.ts ./c.ts run `npm run build` pnpm pytest tsc";
  const s = generateSuggestions(big, 4);
  assert.ok(s.length <= 4, "never exceeds the cap");
  assert.equal(new Set(s.map((a) => a.prompt)).size, s.length, "no duplicate prompts");
});

// ── store: one-shot registration / consumption ─────────────────────────────

test("registerSuggestion + consumeSuggestion is one-shot and chat-scoped", () => {
  const action: SuggestedAction = { label: "x", prompt: "do x" };
  const id = registerSuggestion(42, action);
  // Wrong chat cannot consume it.
  assert.equal(consumeSuggestion(99, id), undefined, "different chat rejected");
  // Correct chat gets it once.
  const got = consumeSuggestion(42, id);
  assert.deepEqual(got, action, "correct chat retrieves the action");
  // Second consume → gone (one-shot).
  assert.equal(consumeSuggestion(42, id), undefined, "consumed id is gone");
});

test("consumeSuggestion: unknown id returns undefined", () => {
  assert.equal(consumeSuggestion(1, "nope"), undefined);
});

// ── keyboard rendering ─────────────────────────────────────────────────────

test("renderSuggestionKeyboard: one button per row, next:<id> callback", () => {
  const actions: SuggestedAction[] = [
    { label: "继续深入", prompt: "p1" },
    { label: "总结要点", prompt: "p2" },
  ];
  const kb = renderSuggestionKeyboard(actions, 7);
  const r = rows(kb);
  assert.equal(r.length, 2, "two suggestions → two rows");
  assert.equal(r[0]![0]!.callback_data?.startsWith("next:"), true, "callback_data prefixed next:");
  assert.equal(r[1]![0]!.callback_data?.startsWith("next:"), true);
  // The registered ids round-trip through consume.
  const id0 = r[0]![0]!.callback_data!.slice("next:".length);
  assert.deepEqual(consumeSuggestion(7, id0), actions[0], "button id resolves to its action");
});
