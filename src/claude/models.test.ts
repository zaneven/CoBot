import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeModelLists } from "./models.js";

test("mergeModelLists: static list first in configured order", () => {
  const merged = mergeModelLists(["b-static", "a-static"], [
    { value: "x", displayName: "X" },
    { value: "y", displayName: "Y" },
  ]);
  assert.deepEqual(merged, ["b-static", "a-static", "x", "y"]);
});

test("mergeModelLists: discovered entries deduped against static", () => {
  const merged = mergeModelLists(["m1", "m2"], [
    { value: "m2", displayName: "dup" },
    { value: "m3", displayName: "new" },
  ]);
  assert.deepEqual(merged, ["m1", "m2", "m3"]);
});

test("mergeModelLists: dedupes within the discovered list itself", () => {
  const merged = mergeModelLists([], [
    { value: "m1", displayName: "a" },
    { value: "m1", displayName: "a again" },
  ]);
  assert.deepEqual(merged, ["m1"]);
});

test("mergeModelLists: skips empty values", () => {
  const merged = mergeModelLists([""], [
    { value: "", displayName: "empty" },
    { value: "ok", displayName: "ok" },
  ]);
  assert.deepEqual(merged, ["ok"]);
});

test("mergeModelLists: caps at 50 entries", () => {
  const discovered = Array.from({ length: 80 }, (_, i) => ({ value: `m${i}`, displayName: `m${i}` }));
  const merged = mergeModelLists(["s0"], discovered);
  assert.equal(merged.length, 50);
  assert.equal(merged[0], "s0");
});
