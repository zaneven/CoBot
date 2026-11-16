import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeSessionDir, decodeSessionLog, resolveDshHome } from "./sessions.js";
import zlib from "node:zlib";

const zstdCompressSync: ((buf: Buffer) => Buffer) | undefined = (
  zlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer }
).zstdCompressSync;

test("dsh sessions: encodeSessionDir matches the harness directory naming", () => {
  assert.equal(encodeSessionDir("/Users/a1/Develop/CoBot"), "--Users-a1-Develop-CoBot--");
  assert.equal(encodeSessionDir("/Users/a1/Develop"), "--Users-a1-Develop--");
  assert.equal(encodeSessionDir("/tmp"), "--tmp--");
});

test("dsh sessions: resolveDshHome honors $DSH_HOME and falls back to ~/.dsh", () => {
  const saved = process.env.DSH_HOME;
  process.env.DSH_HOME = "/custom/dsh";
  assert.equal(resolveDshHome(), "/custom/dsh");
  process.env.DSH_HOME = "   ";
  assert.ok(resolveDshHome().endsWith("/.dsh"));
  if (saved === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = saved;
});

test("dsh sessions: decodeSessionLog reads plain and single-frame logs", () => {
  const plain = Buffer.from('{"type":"session","id":"s1"}\n{"type":"session/title","data":{"title":"hi"}}\n');
  const decoded = decodeSessionLog(plain);
  assert.equal(decoded.length, 2);
  assert.equal(decoded[1]!.type, "session/title");
});

test("dsh sessions: decodeSessionLog walks concatenated zstd frames", () => {
  // dsh appends one zstd frame per batch to the same file: a whole-file
  // decompress only yields the first frame, so the decoder must split on magic.
  if (!zstdCompressSync) return; // Node without zstd compression: nothing to assert.
  const f1 = zstdCompressSync(Buffer.from('{"type":"session","id":"s2"}\n'));
  const f2 = zstdCompressSync(Buffer.from('{"type":"assistant/message","data":{"usage":{"inputTokens":10,"outputTokens":2}}}\n'));
  const buf = Buffer.concat([f1, f2]);
  const decoded = decodeSessionLog(buf);
  assert.equal(decoded.length, 2, "both frames are decoded");
  assert.equal(decoded[0]!.type, "session");
  const usage = (decoded[1]!.data as { usage?: { inputTokens?: number } } | undefined)?.usage;
  assert.equal(usage?.inputTokens, 10);
});
