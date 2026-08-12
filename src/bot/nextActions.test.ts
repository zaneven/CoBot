import { test } from "node:test";
import assert from "node:assert/strict";
import type { InlineKeyboard } from "grammy";
import {
  generateSuggestions,
  registerSuggestion,
  consumeSuggestion,
  renderSuggestionKeyboard,
  extractNextActions,
  parseNextActionsBlock,
  buildNextActions,
  NextActionsStreamFilter,
  type SuggestedAction,
} from "./nextActions.js";

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

// ── model-driven path: <next-actions> block extraction + parsing ───────────

test("extractNextActions: removes the block, keeps the answer", () => {
  const text = "Here is the result.\n<next-actions>\n- 排查报错 | 修复它\n- 运行测试\n</next-actions>";
  const { cleaned, block } = extractNextActions(text);
  assert.equal(cleaned, "Here is the result.", "block stripped, answer preserved");
  assert.ok(block?.includes("排查报错"), "block returned for parsing");
  assert.ok(block?.includes("</next-actions>"), "block includes closing tag");
});

test("extractNextActions: absent block → unchanged, block=null", () => {
  const text = "Just a normal answer with no block.";
  const { cleaned, block } = extractNextActions(text);
  assert.equal(cleaned, text);
  assert.equal(block, null);
});

test("extractNextActions: trailing text after the close tag is kept", () => {
  const text = "Answer.\n<next-actions>\n- 运行测试\n</next-actions>\n(这是脚注)";
  const { cleaned } = extractNextActions(text);
  assert.ok(cleaned.includes("脚注"), "post-block text retained");
  assert.ok(!cleaned.includes("<next-actions>"), "block still removed");
});

test("parseNextActionsBlock: label|instruction and bare label", () => {
  const block = "<next-actions>\n- 排查报错 | 帮我排查错误\n- 运行测试\n</next-actions>";
  const a = parseNextActionsBlock(block);
  assert.equal(a.length, 2);
  assert.equal(a[0]!.label, "排查报错");
  assert.equal(a[0]!.prompt, "帮我排查错误");
  assert.equal(a[1]!.label, "运行测试");
  assert.equal(a[1]!.prompt, "运行测试", "bare label → prompt defaults to label");
});

test("parseNextActionsBlock: tolerates bullets, numbering, and blank lines", () => {
  const block = "<next-actions>\n* 选项一 | 做A\n2. 选项二 | 做B\n\n- 选项三\n</next-actions>";
  const a = parseNextActionsBlock(block);
  assert.deepEqual(a.map((x) => x.label), ["选项一", "选项二", "选项三"]);
  assert.deepEqual(a.map((x) => x.prompt), ["做A", "做B", "选项三"]);
});

test("buildNextActions: uses the block when present", () => {
  const text = "Done.\n<next-actions>\n- 部署到生产 | 执行部署脚本\n- 写发布说明\n</next-actions>";
  const a = buildNextActions(text);
  assert.equal(a.length, 2);
  assert.equal(a[0]!.prompt, "执行部署脚本");
  assert.equal(a[1]!.prompt, "写发布说明");
});

test("buildNextActions: falls back to heuristic when no block", () => {
  const text = "Build failed with an error: exception in main.ts";
  const a = buildNextActions(text);
  assert.ok(a.some((x) => x.label.includes("排查")), "heuristic fallback still fires");
});

// ── streaming filter: hide the block from live ① without leaking a partial tag

test("NextActionsStreamFilter: no block → all text displayed, trailing flushed", () => {
  const f = new NextActionsStreamFilter();
  let out = "";
  for (const d of ["Hel", "lo wor", "ld, no block here."]) out += f.feed(d);
  const fin = f.finish();
  out += fin.trailing;
  assert.equal(out, "Hello world, no block here.", "every char reaches display");
  assert.equal(fin.block, null);
});

test("NextActionsStreamFilter: block mid-stream is hidden, prefix shown", () => {
  const f = new NextActionsStreamFilter();
  let out = "";
  // The opening tag is split across deltas to exercise the hold-back path.
  for (const d of ["Result text.\n<ne", "xt-actions>\n- 运行测试\n</next-actions>"]) out += f.feed(d);
  const fin = f.finish();
  out += fin.trailing;
  assert.equal(out, "Result text.\n", "only the text before the tag is shown");
  assert.ok(fin.block?.includes("运行测试"), "block captured for parsing");
  assert.ok(!out.includes("next-actions"), "tag never leaks into display");
});

test("NextActionsStreamFilter: tag split exactly at delta boundary", () => {
  const f = new NextActionsStreamFilter();
  let out = "";
  for (const d of ["abc<next-actions>", "\n- x | y\n</next-actions>"]) out += f.feed(d);
  const fin = f.finish();
  out += fin.trailing;
  assert.equal(out, "abc", "only pre-tag text shown");
  assert.ok(fin.block?.includes("<next-actions>"), "full block captured");
});
