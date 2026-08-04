import { test } from "node:test";
import assert from "node:assert/strict";
import { largestPhotoId, looksLikeBinary } from "./media.js";

// ── largestPhotoId ──〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("largestPhotoId picks the photo with the biggest file_size", () => {
  const sizes = [
    { file_id: "small", file_size: 1024 },
    { file_id: "medium", file_size: 8192 },
    { file_id: "large", file_size: 32768 },
  ];
  assert.equal(largestPhotoId(sizes), "large");
});

test("largestPhotoId: picks the first when sizes are equal (stable sort)", () => {
  const sizes = [
    { file_id: "a", file_size: 100 },
    { file_id: "b", file_size: 100 },
  ];
  // Same file_size → stable sort preserves original item order → "a" is first.
  assert.equal(largestPhotoId(sizes), "a");
});

test("largestPhotoId handles single photo", () => {
  assert.equal(largestPhotoId([{ file_id: "only", file_size: 42 }]), "only");
});

test("largestPhotoId works with exclude file_size (defaults to 0)", () => {
  const sizes = [
    { file_id: "no_size" },
    { file_id: "has_size", file_size: 10 },
  ] as any[];
  assert.equal(largestPhotoId(sizes), "has_size");
});

// ── looksLikeBinary ─〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("looksLikeBinary: clean UTF-8 is not binary", () => {
  assert.equal(looksLikeBinary(Buffer.from("hello world", "utf8")), false);
  assert.equal(looksLikeBinary(Buffer.from("console.log('hi')", "utf8")), false);
});

test("looksLikeBinary: CJK text is not binary", () => {
  assert.equal(looksLikeBinary(Buffer.from("你好世界", "utf8")), false);
});

test("looksLikeBinary: pure binary buffer", () => {
  // Random bytes produce high replacement-char ratio → binary.
  const buf = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) buf[i] = i;
  assert.equal(looksLikeBinary(buf), true);
});

test("looksLikeBinary: mostly-text with a few bad bytes still text", () => {
  const text = "plain text " + "x".repeat(100);
  const buf = Buffer.from(text, "utf8");
  // Overwrite one byte with an invalid UTF-8 continuation byte.
  buf[0] = 0xFF;
  // Should still decode (with one replacement char among many) → low ratio.
  assert.equal(looksLikeBinary(buf), false);
});

test("looksLikeBinary: empty buffer is not binary", () => {
  assert.equal(looksLikeBinary(Buffer.from("", "utf8")), false);
});