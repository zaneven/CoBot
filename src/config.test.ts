import { test } from "node:test";
import assert from "node:assert/strict";
import { clampTurns, MAX_TURNS } from "./config.js";

test("clampTurns: undefined / 0 / negative -> undefined (SDK default)", () => {
  assert.equal(clampTurns(undefined), undefined);
  assert.equal(clampTurns(0), undefined);
  assert.equal(clampTurns(-5), undefined);
});

test("clampTurns: positive non-integer -> floored", () => {
  assert.equal(clampTurns(12.9), 12);
});

test("clampTurns: values over cap -> clamped to MAX_TURNS", () => {
  assert.equal(clampTurns(100000), MAX_TURNS);
});

test("clampTurns: within range -> unchanged", () => {
  assert.equal(clampTurns(50), 50);
});
