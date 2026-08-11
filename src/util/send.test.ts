import { test } from "node:test";
import assert from "node:assert/strict";
import { sendRichText } from "./send.js";

/** Minimal grammY Api stub. sendRichMessage can be forced to fail to exercise fallback. */
class StubApi {
  richSent: Array<{ markdown: string }> = [];
  htmlSent: Array<{ text: string; options: any }> = [];
  plainSent: string[] = [];
  failRich = false;
  failHtml = false;

  async sendRichMessage(_chatId: number, rich: any): Promise<{ message_id: number }> {
    if (this.failRich) throw new Error("rich unsupported");
    this.richSent.push({ markdown: rich.markdown });
    return { message_id: 1 };
  }

  async sendMessage(_chatId: number, text: string, options?: any): Promise<{ message_id: number }> {
    if (options?.parse_mode === "HTML") {
      if (this.failHtml) throw new Error("html unsupported");
      this.htmlSent.push({ text, options });
    } else {
      this.plainSent.push(text);
    }
    return { message_id: 2 };
  }
}

// ─── 隐患1: sendRichText Rich 通道也过 sanitizeStreamMarkdown ───────────

test("sendRichText: unbalanced fence is balanced before Rich send", async () => {
  const api = new StubApi();
  await sendRichText(api as any, 1, "```\ncode\nstill going");
  assert.equal(api.richSent.length, 1);
  const md = api.richSent[0]!.markdown;
  assert.ok(md.startsWith("```\ncode\nstill going"));
  assert.ok(md.endsWith("```"), "closing fence appended by sanitize");
});

test("sendRichText: balanced content is passed through unchanged", async () => {
  const api = new StubApi();
  const input = "**bold** and `code`";
  await sendRichText(api as any, 1, input);
  assert.equal(api.richSent[0]!.markdown, input);
});

// ─── 隐患2: inline backtick pairs are never mistaken for fences ──────────

test("sanitizeStreamMarkdown: inline `code` pair is NOT treated as a fence", async () => {
  const api = new StubApi();
  await sendRichText(api as any, 1, "wrap it in `code` like this");
  assert.equal(api.richSent[0]!.markdown, "wrap it in `code` like this");
});

test("sanitizeStreamMarkdown: odd trailing backtick is escaped (not fenced)", async () => {
  const api = new StubApi();
  await sendRichText(api as any, 1, "ends with a lone ` tick");
  const md = api.richSent[0]!.markdown;
  assert.ok(md.includes("\\`"), "lone trailing backtick escaped");
  assert.ok(!md.endsWith("```"), "not mistaken for a fence");
});

// ─── 隐患3: tables / LaTeX prefer Rich so structure isn't flattened ──────

test("sendRichText: GFM table uses Rich (structure preserved, not flattened)", async () => {
  const api = new StubApi();
  const table = "| Name | Value |\n| --- | --- |\n| A | 1 |";
  await sendRichText(api as any, 1, table);
  assert.equal(api.richSent.length, 1, "table should be sent via Rich, not HTML-flattened");
  assert.ok(api.richSent[0]!.markdown.includes("| Name | Value |"));
});

test("sendRichText: LaTeX uses Rich (formula preserved natively)", async () => {
  const api = new StubApi();
  await sendRichText(api as any, 1, "Result: $$E=mc^2$$ is correct");
  assert.equal(api.richSent.length, 1);
  assert.ok(api.richSent[0]!.markdown.includes("$$E=mc^2$$"));
});

test("sendRichText: falls back to HTML with readable table when Rich is unavailable", async () => {
  const api = new StubApi();
  api.failRich = true;
  const table = "| Name | Value |\n| --- | --- |\n| A | 1 |";
  await sendRichText(api as any, 1, table);
  assert.equal(api.richSent.length, 0);
  assert.equal(api.htmlSent.length, 1, "fell back to HTML");
  // Flattened but readable: cells joined with ' · ', header bold.
  assert.ok(api.htmlSent[0]!.text.includes("Name"));
  assert.ok(api.htmlSent[0]!.text.includes("Value"));
});
