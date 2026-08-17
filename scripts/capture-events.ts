/**
 * Diagnostic: run a REAL Claude task through the driver, log every DriverEvent
 * (kind + size + snippet), then REPLAY the exact same events through the real
 * TelegramStreamer backed by a recording stub (using the project's real
 * telegram.maxEditChars). Prints the messages the bot would actually produce, so
 * we can see — with ground-truth data — where content gets duplicated.
 *
 *   npx tsx scripts/capture-events.ts
 */
import { runClaude } from "../src/claude/driver.js";
import type { DriverEvent } from "../src/claude/types.js";
import { TelegramStreamer } from "../src/bot/streaming.js";

// ── recording stub (same shape as streaming.test.ts StubApi) ──────────────
interface SentRec { kind: "send" | "edit"; idx: number; len: number; preview: string }
class RecApi {
  sent: SentRec[] = [];
  private nextId = 100;
  private lastId: number | undefined;
  sendRichMessage = async (_c: number, rich: any) => {
    const text = typeof rich === "object" ? rich.markdown ?? rich.html ?? "" : String(rich);
    this.lastId = this.nextId++;
    this.sent.push({ kind: "send", idx: this.lastId, len: text.length, preview: preview(text) });
    return { message_id: this.lastId };
  };
  sendMessage = async (_c: number, text: string) => {
    this.lastId = this.nextId++;
    this.sent.push({ kind: "send", idx: this.lastId, len: text.length, preview: preview(text) });
    return { message_id: this.lastId };
  };
  editMessageText = async (_c: number, id: number, tor: any) => {
    const text = typeof tor === "object" ? tor.markdown ?? tor.html ?? "" : tor;
    this.lastId = id;
    this.sent.push({ kind: "edit", idx: id, len: text.length, preview: preview(text) });
    return true;
  };
  sendChatAction = async () => true;
  deleteMessage = async (_c: number, _id: number) => true;
}
function preview(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? flat.slice(0, 87) + "…" : flat;
}

// ── Part A: real run, capture events ──────────────────────────────────────
const PROMPT = `先读取本项目的 package.json 文件了解项目，然后用中文写一份项目说明文档，要求：
- 不少于 4000 字
- 分为这些小节：项目简介、功能特性、技术栈、安装步骤、使用方法、架构设计、常见问题
- 每个小节都要有实质内容，不要省略
- 不要修改任何文件，只输出这份文档`;
// Run via `npx tsx scripts/capture-events.ts` from the repo root, so the CWD is
// the project the agent should operate on.
const CWD = process.cwd();

async function main() {
  const events: DriverEvent[] = [];
  let streamedText = ""; // accumulated text deltas (what runs.ts feeds the streamer)
  let thinkingChars = 0;
  let rounds = 0;
  let tools = 0;

  console.log("=== Part A: real driver run — capturing events ===");
  const t0 = Date.now();
  for await (const ev of runClaude({
    prompt: { text: PROMPT },
    cwd: CWD,
    permissionMode: "acceptEdits",
    maxTurns: 6,
    timeoutMs: 240_000,
  })) {
    events.push(ev);
    switch (ev.kind) {
      case "init": console.log(`[${events.length}] init  session=${ev.sessionId.slice(0, 8)} model=${ev.model}`); break;
      case "roundStart": rounds++; console.log(`[${events.length}] roundStart  (round #${rounds})`); break;
      case "text":
        streamedText += ev.delta;
        console.log(`[${events.length}] text   +${ev.delta.length}  "${prev(ev.delta)}"  (total streamed=${streamedText.length})`);
        break;
      case "thinking": thinkingChars += ev.delta.length; console.log(`[${events.length}] think  +${ev.delta.length}  (total=${thinkingChars})`); break;
      case "tool": tools++; console.log(`[${events.length}] tool   ${ev.name}  "${prev(ev.summary)}"`); break;
      case "toolResult": console.log(`[${events.length}] tResult ${ev.name}  "${prev(ev.content)}"`); break;
      case "status": console.log(`[${events.length}] status ${ev.status}`); break;
      case "done":
        console.log(`[${events.length}] done   isError=${ev.isError} aborted=${ev.aborted} cost=$${ev.costUsd?.toFixed(4)} dur=${ev.durationMs}ms`);
        console.log(`         ev.text (r.result) length = ${ev.text.length}`);
        console.log(`         streamed-so-far length   = ${streamedText.length}`);
        // Is r.result a tail of / contained in the streamed text?
        const contained = streamedText.includes(ev.text);
        const isSuffix = streamedText.endsWith(ev.text);
        // Longest suffix of streamed that is a prefix of ev.text (what ensureContains computes)
        let ov = 0; const mk = Math.min(streamedText.length, ev.text.length);
        for (let k = 1; k <= mk; k++) if (streamedText.slice(streamedText.length - k) === ev.text.slice(0, k)) ov = k;
        console.log(`         r.result ⊆ streamed? ${contained} | r.result is suffix of streamed? ${isSuffix}`);
        console.log(`         ensureContains overlap (suffix∩prefix) = ${ov} → would append ${ev.text.length - ov} chars`);
        console.log(`         ev.text head: "${prev(ev.text)}"`);
        console.log(`         ev.text tail: "${ev.text.slice(-120).replace(/\s+/g, " ")}"`);
        break;
      case "error": console.log(`[${events.length}] error  ${ev.message}`); break;
    }
  }
  console.log(`\nrun done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${events.length} events, ${rounds} rounds, ${tools} tools, streamed ${streamedText.length} text chars, ${thinkingChars} thinking chars\n`);

  // ── Part B: replay through the real TelegramStreamer ────────────────────
  console.log("=== Part B: replay through real TelegramStreamer (chunking at 32k; maxEditChars=3500 is now vestigial) ===");
  const api = new RecApi();
  // maxEditChars is now vestigial — chunking is at Telegram's 32k hard limit.
  const streamer = new TelegramStreamer(api as any, 1, 3500, 0);
  let taskStartMs = 0;
  let toolCounts: Record<string, number> = {};
  const header = () => {
    const t = taskStartMs ? fmtDur(Date.now() - taskStartMs) : "中";
    const tc = Object.entries(toolCounts); const tot = tc.reduce((a, [, c]) => a + c, 0);
    const det = tc.map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
    return `⏱️ 思考 ${t}` + (tot ? ` · 🔧 调用 ${tot} 个工具（${det}）` : "");
  };
  function fmtDur(ms: number) { const s = Math.round(ms / 1000); if (s < 60) return `${s}秒`; const m = Math.floor(s / 60); const rs = s % 60; return rs ? `${m}分${rs}秒` : `${m}分`; }

  let firstRound = true;
  for (const ev of events) {
    switch (ev.kind) {
      case "roundStart":
        if (firstRound) { streamer.setHeader(header()); taskStartMs = Date.now(); firstRound = false; }
        else streamer.newline();
        break;
      case "text": await streamer.text(ev.delta); break;
      case "thinking": await streamer.thinking(ev.delta); break;
      case "tool": toolCounts[ev.name] = (toolCounts[ev.name] ?? 0) + 1; streamer.setHeader(header()); break;
      case "toolResult": break;
      case "done":
        if (ev.text) streamer.ensureContains(ev.text.trim());
        streamer.setHeader(header());
        await streamer.finalize();
        break;
    }
  }
  // drain pending 0ms-timer flushes
  await new Promise((r) => setTimeout(r, 50));

  console.log(`\nreplay produced ${api.sent.length} send/edit operations:`);
  for (const r of api.sent) {
    console.log(`  ${r.kind === "send" ? "SEND" : "edit"} msg#${r.idx}  len=${r.len}  "${r.preview}"`);
  }

  // ── duplication analysis ───────────────────────────────────────────────
  const sends = api.sent.filter((s) => s.kind === "send");
  console.log(`\n${sends.length} separate messages were SENT (new message ids):`);
  // crude dup check: does any later send's content substantially repeat an earlier one?
  const finalText = api.sent[api.sent.length - 1]?.preview ?? "";
  console.log(`  final op preview: "${finalText}"`);
  const editsPerMsg = new Map<number, number>();
  for (const r of api.sent) if (r.kind === "edit") editsPerMsg.set(r.idx, (editsPerMsg.get(r.idx) ?? 0) + 1);
  console.log(`  edits per message id:`, [...editsPerMsg.entries()]);
}
function prev(s: string): string { const f = s.replace(/\s+/g, " ").trim(); return f.length > 70 ? f.slice(0, 67) + "…" : f; }

main().catch((e) => { console.error("CAPTURE FAILED:", e); process.exit(1); });
