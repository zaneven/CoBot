import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { clampTurns, MAX_TURNS, loadConfig } from "./config.js";

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

test("loadConfig: parses botToken and allowedUsers directly from yaml", () => {
  const tmpPath = resolve(process.cwd(), "config.test.token.yaml");
  writeFileSync(
    tmpPath,
    "telegram:\n  botToken: 'yaml-token-123'\n  allowedUsers: [999111, 888222]\n",
    "utf8",
  );

  try {
    const config = loadConfig(tmpPath);
    assert.equal(config.telegramToken, "yaml-token-123");
    assert.ok(config.allowedUsers.has(999111));
    assert.ok(config.allowedUsers.has(888222));
  } finally {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
  }
});
