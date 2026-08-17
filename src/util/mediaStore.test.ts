import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistMedia, loadMedia, removeMediaDir } from "./mediaStore.js";
import type { MediaAttachment } from "../claude/types.js";

/** Fresh temp dir per test so files never collide across runs. */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mediaStore-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── persistMedia ────────────────────────────────────────────────────────────

test("persistMedia returns null for empty / undefined media", () => {
  assert.equal(persistMedia("t1", [], dir), null);
  assert.equal(persistMedia("t1", undefined as unknown as MediaAttachment[], dir), null);
});

test("persistMedia writes one file per attachment and returns JSON paths", () => {
  const media: MediaAttachment[] = [
    { kind: "image", mediaType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { kind: "pdf", data: Buffer.from("%PDF-1.7 fake"), fileName: "doc.pdf" },
  ];
  const json = persistMedia("t1", media, dir)!;
  assert.ok(json);
  // Files written on disk under <dir>/t1/0 and <dir>/t1/1.
  assert.deepEqual(readdirSync(join(dir, "t1")).sort(), ["0", "1"]);
  const items = JSON.parse(json) as Array<{ path: string; kind: string }>;
  assert.equal(items.length, 2);
  assert.equal(items[0]!.kind, "image");
  assert.equal(items[1]!.kind, "pdf");
  // Stored JSON holds paths, never raw buffers.
  assert.ok(!json.includes("PNG"));
  assert.ok(!json.includes("PDF"));
});

// ── loadMedia round-trip ─────────────────────────────────────────────────────

test("loadMedia reconstructs buffers byte-for-byte", () => {
  const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const textBytes = Buffer.from("console.log(1);", "utf8");
  const media: MediaAttachment[] = [
    { kind: "image", mediaType: "image/jpeg", data: imageBytes, fileName: "shot.jpg" },
    { kind: "text", mediaType: "text/plain", data: textBytes, fileName: "a.py" },
  ];
  const json = persistMedia("t1", media, dir)!;
  const loaded = loadMedia(json, dir)!;
  assert.equal(loaded.length, 2);

  const img = loaded[0]! as Extract<MediaAttachment, { kind: "image" }>;
  assert.equal(img.kind, "image");
  assert.equal(img.mediaType, "image/jpeg");
  assert.equal(img.fileName, "shot.jpg");
  assert.ok(img.data.equals(imageBytes));

  const txt = loaded[1]! as Extract<MediaAttachment, { kind: "text" }>;
  assert.equal(txt.kind, "text");
  assert.equal(txt.mediaType, "text/plain");
  assert.equal(txt.fileName, "a.py");
  assert.ok(txt.data.equals(textBytes));
});

test("loadMedia returns undefined for null / empty input", () => {
  assert.equal(loadMedia(null, dir), undefined);
  assert.equal(loadMedia("", dir), undefined);
});

test("loadMedia defaults missing image mediaType to image/jpeg", () => {
  const json = JSON.stringify([{ kind: "image", data: undefined, path: join(dir, "x") }]);
  // Write the file the persisted path points at.
  writeFileSync(join(dir, "x"), Buffer.from([1, 2, 3]));
  const loaded = loadMedia(json, dir) as Array<{ kind: string; mediaType: string }>;
  assert.equal(loaded[0]!.kind, "image");
  assert.equal(loaded[0]!.mediaType, "image/jpeg");
});

// ── removeMediaDir ──────────────────────────────────────────────────────────

test("removeMediaDir deletes the task's media folder", () => {
  persistMedia("t1", [{ kind: "pdf", data: Buffer.from("x") }], dir);
  assert.ok(existsSync(join(dir, "t1")));
  removeMediaDir("t1", dir);
  assert.ok(!existsSync(join(dir, "t1")));
});

test("removeMediaDir is a no-op for missing folders (best-effort)", () => {
  assert.doesNotThrow(() => removeMediaDir("ghost", dir));
});