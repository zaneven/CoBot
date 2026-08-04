import { test } from "node:test";
import assert from "node:assert/strict";
import type { PromptInput } from "./types.js";
import { buildSdkPrompt } from "./driver.js";

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };

function build(input: PromptInput): string | AsyncIterable<any> {
  return buildSdkPrompt(input);
}

async function collect(it: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const v of it) out.push(v);
  return out;
}

test("no media -> raw string (fast path)", () => {
  const r = build({ text: "hello" });
  assert.equal(typeof r, "string");
  assert.equal(r, "hello");
});

test("no media with empty text -> empty string", () => {
  assert.equal(build({ text: "" }), "");
});

test("with image -> one user message, text block then image block, base64 data", async () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // dummy jpeg bytes
  const r = await collect(
    build({ text: "see this", media: [{ kind: "image", mediaType: "image/jpeg", data: buf }] }) as AsyncIterable<any>,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0]!.type, "user");
  assert.equal(r[0]!.message.role, "user");
  const blocks = r[0]!.message.content as Block[];
  assert.deepEqual(blocks[0]!, { type: "text", text: "see this" });
  assert.equal(blocks[1]!.type, "image");
  assert.equal(blocks[1]!.source!.type, "base64");
  assert.equal(blocks[1]!.source!.media_type, "image/jpeg");
  assert.equal(blocks[1]!.source!.data, buf.toString("base64"));
});

test("pdf -> document block with application/pdf", async () => {
  const buf = Buffer.from("%PDF-1.4");
  const r = await collect(
    build({ text: "", media: [{ kind: "pdf", data: buf }] }) as AsyncIterable<any>,
  );
  const blocks = r[0]!.message.content as Block[];
  assert.equal(blocks[0]!.type, "document", "empty text yields no text block, just the document");
  assert.equal(blocks[0]!.source!.media_type, "application/pdf");
});

test("text file -> inlined fenced text block, truncated past limit", async () => {
  const big = "x".repeat(210_000);
  const buf = Buffer.from(big, "utf8");
  const r = await collect(
    build({ text: "review this", media: [{ kind: "text", mediaType: "text/plain", data: buf, fileName: "log.txt" }] }) as AsyncIterable<any>,
  );
  const blocks = r[0]!.message.content as Block[];
  assert.deepEqual(blocks[0]!, { type: "text", text: "review this" });
  assert.equal(blocks[1]!.type, "text");
  assert.ok(blocks[1]!.text!.startsWith("📎 log.txt (text/plain)"));
  assert.ok(blocks[1]!.text!.includes("[truncated]"));
  assert.ok(blocks[1]!.text!.length < 220_000);
});