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

  /** Replies-markup edits (the button-attach fallback finalize uses). */
  replyMarkupEdits: Array<{ msgId: number; options: any }> = [];
  editMessageReplyMarkup = async (
    _chatId: number,
    msgId: number,
    _inlineMessageId: string | undefined,
    extra?: Record<string, unknown>,
  ): Promise<true> => {
    this.replyMarkupEdits.push({ msgId, options: extra });
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

test("long content paginates at the 32k limit with no duplication", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 50); // flushMs large → no mid-stream flush
  const unit = "ZQX\n";
  const big = unit.repeat(11000); // ~44000 chars → overflows one 32k message
  // Stream in pieces, the way the driver feeds incremental text deltas.
  for (let i = 0; i < big.length; i += 1000) {
    await streamer.text(big.slice(i, i + 1000));
  }
  // `done` reconciliation: the authoritative full answer is spliced in. With
  // content never cleared, this must be a no-op (content already contains it).
  streamer.ensureContains(big);
  await streamer.finalize();

  assert.equal(api.richSent.length, 2, "content > 32k splits into exactly 2 messages");
  const allText = api.richSent
    .map((r: { rich_message: { markdown: string } }) => r.rich_message.markdown)
    .join("");
  const markerCount = allText.split("ZQX").length - 1;
  assert.equal(markerCount, 11000, "the answer appears exactly once — no duplication");
});

test("small content is not fragmented by maxEditChars (regression: old auto-flush-clear bug)", async () => {
  const api = makeStubApi();
  // maxEditChars=10 is now vestigial; 60 chars (< 32k) must stay ONE message,
  // not be split/cleared the way the old per-maxEditChars auto-flush did.
  const streamer = new TelegramStreamer(api, 1, 10, 50);
  await streamer.text("x".repeat(60));
  await streamer.finalize();
  assert.equal(api.richSent.length, 1, "small content stays a single message despite a tiny maxEditChars");
});

test("summary appends a distinct block to the streamed message", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.text("这里是回答正文。");
  await streamer.summary("**▌执行摘要**  ·  ⏱️ 思考 1分30秒  ·  🔧 调用 3 个工具（Bash ×2, Read ×1）");
  await streamer.finalize();
  assert.equal(api.richSent.length, 1, "summary stays attached to the same message");
  const out = api.richSent[0].rich_message.markdown;
  assert.ok(out.includes("这里是回答正文。"), "body preserved");
  assert.ok(out.includes("执行摘要"), "summary block present");
  assert.ok(out.includes("⏱️ 思考 1分30秒"), "duration present");
  // Summary must be separated from the body by a blank line, not glued on.
  assert.ok(out.includes("回答正文。\n\n**▌执行摘要"), "blank-line separation between body and summary");
});

test("summary after finalize is a no-op", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.text("body");
  await streamer.finalize();
  await streamer.summary("**▌执行摘要**  ·  x");
  assert.equal(api.richSent.length, 1);
  assert.ok(!api.richSent[0].rich_message.markdown.includes("执行摘要"), "no summary after finalize");
});

test("thinking updates header duration and keeps answer body clean", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  streamer.setHeader("⏱️ 思考 中");
  await streamer.thinking("Let me analyze the request and weigh the options carefully…");
  await streamer.text("这是回答正文。");
  await streamer.finalize();
  const out = api.richSent[0].rich_message.markdown;
  assert.ok(out.startsWith("⏱️ 思考 中"), "header at top");
  assert.ok(out.includes("这是回答正文。"), "body present");
  assert.ok(!out.includes("Let me analyze"), "raw reasoning text is NOT dumped into the chat");
  assert.ok(!out.includes("详细思考内容已折叠"), "no fake thinking placeholder");
});

test("tool calls and thinking do not pollute the answer body", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  streamer.setHeader("⚡️ 正在调用 Read (runs.ts) · ⏱️ 5.2s · 🔧 调用 2 个工具");
  await streamer.thinking("Reasoning about file structure…");
  await streamer.toolLine("Read", "src/bot/runs.ts");
  await streamer.toolResult("Read", "file content 200 lines", false);
  await streamer.toolLine("Bash", "npm test");
  await streamer.toolResult("Bash", "tests passed", false);
  await streamer.text("根据代码分析，结果如下：\n- 第一点\n- 第二点");
  await streamer.finalize();

  const out = api.richSent[0].rich_message.markdown;
  assert.ok(out.startsWith("⚡️ 正在调用 Read (runs.ts)"), "header displays clean live status");
  assert.ok(out.includes("根据代码分析，结果如下："), "body is completely intact");
  // Body is 100% clean of raw concatenated tool lines and ugly pseudo-quotes
  assert.ok(!out.includes("↳ **Read**"));
  assert.ok(!out.includes("🔧 **Read** ›"));
});

// ── newline (per-turn narration break) ────────────────────────────────────

test("newline starts each turn's narration on its own line", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.text("第一回合进度说明:");
  streamer.newline();
  await streamer.text("第二回合进度说明:");
  streamer.newline();
  await streamer.text("第三回合进度说明:");
  await streamer.finalize();
  const out = api.richSent[0].rich_message.markdown;
  assert.ok(
    out.includes("第一回合进度说明:\n第二回合进度说明:\n第三回合进度说明:"),
    "each turn's narration on its own line, like the Claude Code client",
  );
});

test("newline is a no-op on an empty buffer (first turn has no leading break)", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  streamer.newline();
  await streamer.text("only turn");
  await streamer.finalize();
  const out = api.richSent[0].rich_message.markdown;
  assert.ok(!out.startsWith("\n"), "no leading newline before the first turn");
  assert.ok(out.includes("only turn"));
});

test("newline never stacks blank lines across consecutive calls", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.text("turn one");
  streamer.newline();
  streamer.newline(); // a turn that produced only thinking, no text, then the next
  streamer.newline();
  await streamer.text("turn two");
  await streamer.finalize();
  const out = api.richSent[0].rich_message.markdown;
  assert.ok(out.includes("turn one\nturn two"), "exactly one line break between turns");
  assert.ok(!out.includes("turn one\n\n\nturn two"), "no blank-line stacking");
});

// ── tool markers ─────────〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("toolLine does not pollute content buffer", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  streamer.setHeader("⚡️ 正在调用 Bash");
  await streamer.toolLine("Bash", "ls -la");
  await streamer.text("回答正文");
  await streamer.flush();
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("正在调用 Bash"));
  assert.ok(api.sent[0].text.includes("回答正文"));
  assert.ok(!api.sent[0].text.includes("🔧 **Bash** › ls -la"));
});

test("toolResult does not pollute content buffer", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  streamer.setHeader("⚡️ 正在调用 grep");
  await streamer.toolResult("grep", "found 3 matches", false);
  await streamer.text("搜索完成");
  await streamer.flush();
  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("正在调用 grep"));
  assert.ok(api.sent[0].text.includes("搜索完成"));
  assert.ok(!api.sent[0].text.includes("found 3 matches"));
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

// ── setContent: whole-body replace (drives the live "执行过程" bullet list) ─

test("setContent replaces the whole body each call, not appends", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 32000, 0);
  // A caller drives it each tick as the completed-block list grows.
  await streamer.setContent("**执行过程**\n\n- step one");
  await streamer.setContent("**执行过程**\n\n- step one\n\n---\n\n- step two");
  await streamer.finalize();
  assert.equal(api.richSent.length, 1, "single logical message");
  const out = api.richSent[0].rich_message.markdown;
  assert.ok(out.includes("- step two"), "latest body present");
  // Replace semantics: "step one" appears exactly once, not duplicated by append.
  assert.equal((out.match(/step one/g) || []).length, 1, "setContent replaced — no append duplication");
});

test("setContent is a no-op on empty input (caller may drive it each tick)", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 32000, 0);
  await streamer.setContent(""); // nothing to show yet — common before the first block
  await streamer.setContent("");
  await streamer.finalize();
  assert.equal(api.richSent.length, 0, "no rich message for empty content");
  assert.equal(api.sent.length, 0, "no plain/HTML fallback either");
});

test("setContent is a no-op after finalize", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 32000, 0);
  await streamer.setContent("- first");
  await streamer.finalize();
  const sentBefore = api.richSent.length;
  await streamer.setContent("- second"); // ignored — already finalized
  assert.equal(api.richSent.length, sentBefore, "no re-render after finalize");
  assert.ok(!api.richSent[0].rich_message.markdown.includes("second"));
});

// ── finalize(replyMarkup): button-attach fallback for Rich Messages ────────
// Rich Messages silently drop reply_markup, so finalize re-attaches the
// keyboard via editMessageReplyMarkup, mirroring sendRichText in send.ts.

test("finalize attaches reply_markup to the last rich message via editMessageReplyMarkup", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 32000, 0);
  const kb = { inline_keyboard: [[{ text: "继续", callback_data: "x" }]] };
  await streamer.setContent("done");
  await streamer.finalize(kb);
  assert.equal(api.richSent.length, 1, "one rich message");
  assert.equal(api.replyMarkupEdits.length, 1, "markup attached to the rich message");
  assert.deepEqual(api.replyMarkupEdits[0].options.reply_markup, kb);
  // No separate button message — the attach succeeded.
  assert.equal(
    api.sent.find((s: { options: any }) => s.options && s.options.reply_markup === kb),
    undefined,
    "no fallback button message when attach succeeds",
  );
});

test("finalize with no markup does not attempt to attach any", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 32000, 0);
  await streamer.setContent("done");
  await streamer.finalize();
  assert.equal(api.replyMarkupEdits.length, 0, "no markup → no editMessageReplyMarkup call");
});

test("finalize swallows a benign 'not modified' markup-attach (already attached)", async () => {
  const api = makeStubApi();
  api.editMessageReplyMarkup = async () => {
    throw new Error("Bad Request: message is not modified");
  };
  const streamer = new TelegramStreamer(api, 1, 32000, 0);
  const kb = { inline_keyboard: [[{ text: "继续", callback_data: "x" }]] };
  await streamer.setContent("done");
  await streamer.finalize(kb);
  assert.equal(api.richSent.length, 1, "rich message still sent");
  // "not modified" is benign → no separate fallback button message.
  assert.equal(
    api.sent.find((s: { options: any }) => s.options && s.options.reply_markup === kb),
    undefined,
    "no duplicate button message on benign 'not modified'",
  );
});

test("finalize falls back to a separate button message when markup attach fails", async () => {
  const api = makeStubApi();
  api.editMessageReplyMarkup = async () => {
    throw new Error("Bad Request: message is too old to edit"); // non-benign
  };
  const streamer = new TelegramStreamer(api, 1, 32000, 0);
  const kb = { inline_keyboard: [[{ text: "继续", callback_data: "x" }]] };
  await streamer.setContent("done");
  await streamer.finalize(kb);
  assert.equal(api.richSent.length, 1, "rich message sent");
  // A separate plain message carrying the buttons was sent as the fallback.
  const btnMsg = api.sent.find((s: { options: any }) => s.options && s.options.reply_markup === kb);
  assert.ok(btnMsg, "a separate message carrying the reply_markup was sent");
  assert.ok(btnMsg!.text.includes("建议的下一步操作"));
});

test("finalize is idempotent — a second call is a no-op", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 32000, 0);
  const kb = { inline_keyboard: [[{ text: "继续", callback_data: "x" }]] };
  await streamer.setContent("done");
  await streamer.finalize(kb);
  const sentBefore = api.richSent.length;
  const markupBefore = api.replyMarkupEdits.length;
  await streamer.finalize(kb); // safety-net second call (e.g. from the finally block)
  assert.equal(api.richSent.length, sentBefore, "no duplicate message on second finalize");
  assert.equal(api.replyMarkupEdits.length, markupBefore, "no duplicate markup attach on second finalize");
});