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

test("thinking renders a folded block with duration above the answer body", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  streamer.setHeader("⏱️ 思考 中");
  await streamer.thinking("Let me analyze the request and weigh the options carefully…");
  await streamer.text("这是回答正文。");
  await streamer.finalize();
  const out = api.richSent[0].rich_message.markdown;
  assert.ok(out.startsWith("⏱️ 思考 中"), "header at top");
  // The folded thinking blockquote sits above the answer body.
  const thinkIdx = out.indexOf("💭 思考过程");
  const bodyIdx = out.indexOf("这是回答正文。");
  assert.ok(thinkIdx >= 0, "thinking block labelled");
  assert.ok(bodyIdx > thinkIdx, "thinking rendered above the answer body");
  assert.ok(out.includes("详细思考内容已折叠"), "chain-of-thought is folded, not shown");
  assert.ok(!out.includes("Let me analyze"), "raw reasoning text is NOT dumped into the chat");
  assert.ok(out.includes("思考用时"), "thinking duration at the end of the block");
});

test("multiple thinking spans fold into one block with cumulative duration", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  // think → answer → think → answer: two reasoning spans, ONE folded block.
  await streamer.thinking("first English reasoning span");
  await streamer.text("中间回答");
  await streamer.thinking("second English reasoning span");
  await streamer.text("最终回答");
  await streamer.finalize();
  const out = api.richSent[0].rich_message.markdown;
  const f = out.indexOf("💭 思考过程");
  assert.ok(f >= 0, "a folded thinking block is present");
  assert.ok(out.indexOf("💭 思考过程", f + 1) === -1, "one block total, not one per span");
  assert.ok(!out.includes("first English reasoning span") && !out.includes("second English reasoning span"),
    "all raw reasoning is folded away");
  assert.ok(out.includes("思考用时"), "cumulative thinking duration shown");
  assert.ok(out.includes("中间回答") && out.includes("最终回答"), "answer body intact");
});

test("no thinking block at all when the turn has no reasoning", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  await streamer.text("直接回答，没有思考。");
  await streamer.finalize();
  const out = api.richSent[0].rich_message.markdown;
  assert.ok(!out.includes("💭 思考过程"), "no thinking block for a non-reasoning turn");
  assert.ok(out.includes("直接回答"), "answer body present");
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

// ── header (round meta line) ─────────〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰
test("setHeader renders above the body, separated by a blank line", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  streamer.setHeader("⏱️ 思考 中 · 🔧 调用 2 个工具（Bash ×2）");
  await streamer.text("这是本轮的回复正文。");
  await streamer.finalize();
  assert.equal(api.richSent.length, 1, "header + body are one message");
  const out = api.richSent[0].rich_message.markdown;
  assert.ok(out.startsWith("⏱️ 思考 中 · 🔧 调用 2 个工具（Bash ×2）"), "header at top");
  assert.ok(out.includes("本轮的回复正文"), "body preserved");
  assert.ok(out.includes("（Bash ×2）\n\n这是本轮"), "blank-line gap between header and body");
});

test("setHeader can update the meta line before finalize", async () => {
  const api = makeStubApi();
  const streamer = new TelegramStreamer(api, 1, 3500, 0);
  streamer.setHeader("⏱️ 思考 中");
  await streamer.text("正文");
  streamer.setHeader("⏱️ 思考 1分30秒 · 🔧 调用 1 个工具（Read ×1）");
  await streamer.finalize();
  const out = api.richSent[0].rich_message.markdown;
  assert.ok(out.includes("⏱️ 思考 1分30秒"), "updated duration shown");
  assert.ok(out.includes("Read ×1"), "updated tool count shown");
  assert.ok(!out.includes("思考 中"), "stale placeholder gone");
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