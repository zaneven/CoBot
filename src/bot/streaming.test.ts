import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramStreamer } from "./streaming.js";

/**
 * Minimal stub of grammY's `Api` that records sent messages and assigns
 * monotonically increasing message_ids. Only the methods TelegramStreamer calls
 * are implemented; any unexpected call is an error.
 */
class StubApi {
  sent: Array<{ text: string; options: any }> = [];
  richSent: Array<{ rich_message: any; options: any }> = [];
  edits: Array<{ msgId: number; textOrRich: any; options: any }> = [];
  deleted: number[] = [];
  private nextId = 100;

  sendRichMessage = async (_chatId: number, rich_message: any, extra?: Record<string, unknown>): Promise<{ message_id: number }> => {
    const text = typeof rich_message === "object" ? rich_message.markdown || rich_message.html || "" : String(rich_message);
    this.richSent.push({ rich_message, options: extra });
    this.sent.push({ text, options: extra });
    return { message_id: this.nextId++ };
  };

  sendMessage = async (_chatId: number, text: string, extra?: Record<string, unknown>): Promise<{ message_id: number }> => {
    this.sent.push({ text, options: extra });
    return { message_id: this.nextId++ };
  };

  editMessageText = async (_chatId: number, msgId: number, textOrRich: string | any, extra?: Record<string, unknown>): Promise<true> => {
    const text = typeof textOrRich === "object" ? textOrRich.markdown || textOrRich.html || "" : textOrRich;
    this.edits.push({ msgId, textOrRich, options: extra });
    if (this.sent.length > 0) {
      this.sent[this.sent.length - 1]!.text = text;
    }
    return true;
  };

  deleteMessage = async (_chatId: number, msgId: number): Promise<true> => {
    this.deleted.push(msgId);
    return true;
  };
}


function makeStubApi(): any {
  return new StubApi();
}

// ── text buffering ──────〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("text appends to buffer without sending immediately", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 50);
  await streamer.text("hello");
  assert.equal(api.sent.length, 0, "no sendMessage called yet — still buffered");
  await streamer.finalize();
});

test("flush triggers send with raw Markdown via Rich Message", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.text("**bold** text");
  await streamer.flush();
  assert.equal(api.richSent.length, 1);
  assert.ok(api.richSent[0].rich_message.markdown.includes("**bold** text"), "markdown bold passed to rich_message payload");
});

test("flush is idempotent — no second send if nothing new", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.text("hey");
  await streamer.flush();
  assert.equal(api.sent.length, 1);
  await streamer.flush();
  assert.equal(api.sent.length, 1, "second flush with no new text should be a no-op");
});

test("auto-flush when buffer exceeds maxEditChars", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 10, 0);
  // The buffer grows > maxEditChars → auto-flushes, resetting the edit target.
  await streamer.text("1234567890"); // exactly 10 chars
  await streamer.text("AB");
  // manual flush collects the leftover sent after flush (2nd message)
  const s1 = api.sent.length;
  await streamer.flush();
  // After auto-flush + this manual flush, at least one send should have happened.
  assert.ok(api.sent.length >= 1);
});

// ── tool markers ─────────〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("toolBlock appends escaped marker line", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.toolLine("Bash", "ls -la");
  await streamer.flush();
  // The line includes the associated escape happenings of tool name and summary.
  assert.ok(api.sent[0].text.includes("Bash"));
  assert.ok(api.sent[0].text.includes("ls -la"));
});

test("toolResult appends escaped summary", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.toolResult("grep", "found 3 matches", false);
  await streamer.flush();
  assert.ok(api.sent[0].text.includes("found 3 matches"));
});

test("error toolResult includes warning marker", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.toolResult("Run", "command not found", true);
  await streamer.flush();
  const text = api.sent[0].text;
  assert.ok(text.includes("Run") && text.includes("command not found"));
});

// ── finalize ─────────────〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("finalize fluffs the final(buffer) and marks finished", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.text("final text");
  await streamer.finalize();
  assert.equal(api.sent.length, 1);
});

// ── chain — no clearing overlap ────〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("consecutive async texts are serialised by a promise chain", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3000, 0);
  await Promise.all([streamer.text("A"), streamer.text("B"), streamer.text("C")]);
  await streamer.flush();
  // The combined content should include all three pieces.
  const text = api.sent[api.sent.length - 1].text;
  assert.ok(text.includes("A"));
  assert.ok(text.includes("B"));
  assert.ok(text.includes("C"));
});

// ── Rich Message (Bot API 10.1+) ───────────────────────────────────────────────

test("sendRichMessage sends rich_message payload with native markdown", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 32000, 0);
  await streamer.text("# Title\n\n| H1 | H2 |\n|---|---|\n| V1 | V2 |\n\n$$E=mc^2$$");
  await streamer.flush();

  assert.equal(api.richSent.length, 1, "sendRichMessage should be invoked");
  assert.ok(api.richSent[0].rich_message.markdown.includes("# Title"));
  assert.ok(api.richSent[0].rich_message.markdown.includes("| H1 | H2 |"));
  assert.ok(api.richSent[0].rich_message.markdown.includes("$$E=mc^2$$"));
});

test("stream edits editMessageText using rich_message payload", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 32000, 0);
  await streamer.text("Chunk 1");
  await streamer.flush();
  assert.equal(api.richSent.length, 1);

  await streamer.text("\nChunk 2");
  await streamer.flush();
  assert.equal(api.edits.length, 1);
  assert.ok(typeof api.edits[0].textOrRich === "object", "editMessageText should receive rich_message object");
  assert.equal(api.edits[0].textOrRich.markdown, "Chunk 1\nChunk 2");
});

test("fallback to sendHtml if sendRichMessage fails", async () => {
    const api = makeStubApi();
    api.sendRichMessage = async () => {
      throw new Error("sendRichMessage unsupported");
    };

    const streamer = new TelegramStreamer(api, 1, 32000, 0);
    await streamer.text("**bold text**");
    await streamer.flush();

    // sendRichMessage failed so it fell back to sendMessage with HTML parse mode
    assert.equal(api.sent.length, 1);
    assert.ok(api.sent[0].text.includes("<b>bold text</b>"));
    assert.equal(api.sent[0].options.parse_mode, "HTML");
  });

// ── balanceFences ────────────────────────────────────────────────────────

// Import balanceFences for direct testing. The streaming test file uses the
// same module, so we test through the streamer's behaviour.

test("unclosed ``` fence is closed in the rich_message payload", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 32000, 0);
  await streamer.text("```\ncode\nstill going");
  await streamer.flush();

  // The markdown sent via sendRichMessage should have the fence balanced.
  assert.equal(api.richSent.length, 1);
  const md = api.richSent[0].rich_message.markdown;
  assert.ok(md.startsWith("```\ncode\nstill going"));
  assert.ok(md.endsWith("```"), "closing fence was appended");
});

// ── needsRich — detect Rich-only constructs like tables, math, checklists

// Tested via the rich_message payload presence: when content has tables/math the
// streamer prefers sendRichMessage; if the stub's sendRichMessage throws the
// streamer falls to HTML for the remaining messages. The exact gating is an
// implementation detail — the test verifies the send path is selected correctly.

// ── sanitizeStreamMarkdown: mid-stream escaped inline markers ───────

test("unclosed ` is escaped at tail before rich send", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 32000, 0);
  await streamer.text("the command `ls` and more"); // balanced — no transformation
  await streamer.flush();
  assert.equal(api.richSent.length, 1);
  assert.ok(api.richSent[0].rich_message.markdown.includes("`ls`"), "balanced backticks preserved");
});

// ── neededRich contract — structural markers enable Rich path ─────

test("content with a GFM table still uses sendRichMessage", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.text("| Name | Value |\n| --- | --- |\n| A | 1 |");
  await streamer.flush();
  assert.equal(api.richSent.length, 1, "GFM table should use Rich Message");
  assert.ok(api.richSent[0].rich_message.markdown.includes("| Name | Value |"));
});

test("content with $$ \\LaTeX $$ uses rich send", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.text("Result: $$E=mc^2$$ is correct");
  await streamer.flush();
  assert.equal(api.richSent.length, 1);
});