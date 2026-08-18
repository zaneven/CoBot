import { test } from "node:test";
import assert from "node:assert/strict";
import { mdToTelegramHtml, escapeMd } from "./tgfmt.js";

// ── inline ──────────────────────────────────────────────────────────────────

test("bold / italic / code / strikethrough", () => {
  assert.equal(mdToTelegramHtml("**b** _i_ `c` ~~s~~"), "<b>b</b> <i>i</i> <code>c</code> <s>s</s>");
});

test("nested emphasis", () => {
  assert.equal(mdToTelegramHtml("Use **bold *nested* end** here."), "Use <b>bold <i>nested</i> end</b> here.");
});

test("link", () => {
  assert.equal(
    mdToTelegramHtml("Visit [Anthropic](https://www.anthropic.com) now."),
    'Visit <a href="https://www.anthropic.com">Anthropic</a> now.',
  );
});

test("unsafe link schemes are dropped to literal text", () => {
  // javascript: URL is rejected, so the whole [text](url) renders literally.
  assert.equal(mdToTelegramHtml("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
});

test("HTML special chars are escaped in prose", () => {
  assert.equal(
    mdToTelegramHtml('Line with <tag> & ampersand "quotes"'),
    'Line with &lt;tag&gt; &amp; ampersand "quotes"',
  );
});

test("paths and globs are not mangled", () => {
  assert.equal(mdToTelegramHtml("Path: /Users/a1/foo_bar.ts and glob *.ts"), "Path: /Users/a1/foo_bar.ts and glob *.ts");
});

test("backslash escapes render literally", () => {
  assert.equal(mdToTelegramHtml("Literal \\*not bold\\*"), "Literal *not bold*");
});

// ── blocks ──────────────────────────────────────────────────────────────────

test("ATX heading renders bold", () => {
  assert.equal(mdToTelegramHtml("## Heading"), "<b>Heading</b>");
});

test("unordered list uses bullets", () => {
  assert.equal(mdToTelegramHtml("- one\n- two"), "• one\n• two");
});

test("ordered list is preserved", () => {
  assert.equal(mdToTelegramHtml("1. first\n2. second"), "1. first\n2. second");
});

test("blockquote", () => {
  assert.equal(mdToTelegramHtml("> quoted\n> more"), "<blockquote>quoted\nmore</blockquote>");
});

test("expandable blockquote", () => {
  assert.equal(
    mdToTelegramHtml("**>** expandable 1\n**>** expandable 2"),
    "<blockquote expandable>expandable 1\nexpandable 2</blockquote>",
  );
  assert.equal(
    mdToTelegramHtml(">! tag 1\n>! tag 2"),
    "<blockquote expandable>tag 1\ntag 2</blockquote>",
  );
});

test("fenced code escapes HTML", () => {
  assert.equal(mdToTelegramHtml("```ts\na < b && c > d\n```"), "<pre>a &lt; b &amp;&amp; c &gt; d</pre>");
});

// ── partial / mid-stream input ───────────────────────────────────────────────

test("unclosed emphasis renders literally (mid-stream safe)", () => {
  // A lone ** with no close must not emit a <b> (would break HTML on next edit).
  assert.equal(mdToTelegramHtml("Unclosed **bold here"), "Unclosed **bold here");
  const out = mdToTelegramHtml("Unclosed `code mid-stream");
  assert.ok(!out.includes("<code>"), "unterminated backtick must not open a <code> tag");
});

test("unclosed fence still closes the <pre> tag", () => {
  const out = mdToTelegramHtml("```\ncode\nstill code");
  assert.equal(out, "<pre>code\nstill code</pre>");
  assert.ok(out.endsWith("</pre>"));
});

// ── tables ───────────────────────────────────────────────────────────────────

test("simple ascii table aligns and separates", () => {
  const out = mdToTelegramHtml("| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |");
  assert.equal(out, "<b>Name</b> · <b>Age</b>\n<b>Alice</b> · 30\n<b>Bob</b> · 25");
});

test("table without edge pipes", () => {
  const out = mdToTelegramHtml("Name | Age\n--- | ---\nAlice | 30\nBob | 25");
  assert.equal(out, "<b>Name</b> · <b>Age</b>\n<b>Alice</b> · 30\n<b>Bob</b> · 25");
});

test("alignment markers (left/center/right)", () => {
  const out = mdToTelegramHtml("| left | center | right |\n| :--- | :---: | ---: |\n| a | b | c |\n| xx | yy | zz |");
  assert.equal(out, "<b>left</b> · <b>center</b> · <b>right</b>\n<b>a</b> · b · c\n<b>xx</b> · yy · zz");
});

test("CJK table aligns by display width", () => {
  const out = mdToTelegramHtml("| 名称 | 数量 | 价格 |\n| --- | --- | --- |\n| 苹果 | 3 | 12.5 |\n| 香蕉 | 10 | 4 |");
  assert.equal(out, "<b>名称</b> · <b>数量</b> · <b>价格</b>\n<b>苹果</b> · 3 · 12.5\n<b>香蕉</b> · 10 · 4");
});

test("escaped pipe inside a cell", () => {
  const out = mdToTelegramHtml("| cmd | desc |\n| --- | --- |\n| a \\| b | pipe in cell |");
  assert.equal(out, "<b>cmd</b> · <b>desc</b>\n<b>a | b</b> · pipe in cell");
});

test("non-table (no delimiter row) stays plain", () => {
  const out = mdToTelegramHtml("price | qty\n5 | 10");
  assert.equal(out, "price | qty\n5 | 10");
  assert.ok(!out.includes("<pre>"));
});

test("header alone (mid-stream) is not yet a table", () => {
  const out = mdToTelegramHtml("| Name | Age |");
  assert.equal(out, "| Name | Age |");
  assert.ok(!out.includes("<pre>"));
});

// ── escapeMd ─────────────────────────────────────────────────────────────────

test("escapeMd prefixes markdown-special punctuation", () => {
  assert.equal(escapeMd("a*b"), "a\\*b");
  assert.equal(escapeMd("a`b"), "a\\`b");
  assert.equal(escapeMd("a_b"), "a\\_b");
  assert.equal(escapeMd("a~b"), "a\\~b");
  assert.equal(escapeMd("a[b]c"), "a\\[b\\]c");
  assert.equal(escapeMd("a!b#c"), "a\\!b\\#c");
  assert.equal(escapeMd("a\\b"), "a\\\\b");
});

test("escapeMd content renders literally through the converter", () => {
  // ** would normally bold; once escaped it must show as literal asterisks.
  assert.equal(mdToTelegramHtml(escapeMd("**not bold**")), "**not bold**");
});
