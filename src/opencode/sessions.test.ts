import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessionListOutput } from "./sessions.js";

test("OpenCode sessions: parseSessionListOutput parses table format", () => {
  const sample = `
1.18.25
Session ID                      Title                            Updated
────────────────────────────────────────────────────────────────────────
ses_fa9023a79ffeNYXl85JuliCm4Z  cobot对Claude Code任务规划的处理与显示逻辑分析  5:44 PM · 8/31/2026
ses_fe8358391ffehgHH3kjcwHAMqF  Analyzing current project        10:13 AM · 8/19/2026
ses_fed314b4affeUgmsttAsngD84k  问候                               11:05 AM · 8/18/2026
`;

  const sessions = parseSessionListOutput(sample);
  assert.equal(sessions.length, 3);

  assert.equal(sessions[0]?.sessionId, "ses_fa9023a79ffeNYXl85JuliCm4Z");
  assert.equal(sessions[0]?.summary, "cobot对Claude Code任务规划的处理与显示逻辑分析");
  assert.ok((sessions[0]?.lastModified ?? 0) > 0);

  assert.equal(sessions[1]?.sessionId, "ses_fe8358391ffehgHH3kjcwHAMqF");
  assert.equal(sessions[1]?.summary, "Analyzing current project");

  assert.equal(sessions[2]?.sessionId, "ses_fed314b4affeUgmsttAsngD84k");
  assert.equal(sessions[2]?.summary, "问候");
});

test("OpenCode sessions: parseSessionListOutput returns empty array for empty input", () => {
  const sessions = parseSessionListOutput("");
  assert.deepEqual(sessions, []);
});
