import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOpenCodeJsonEvent,
  shouldStartRound,
  summarizeToolInput,
  resolveOpenCodeExecutable,
} from "./driver.js";

test("OpenCode driver: shouldStartRound transitions", () => {
  // Initial state
  let state = { roundActive: false, pendingNewRound: true };
  const r1 = shouldStartRound(state, "text");
  assert.equal(r1.start, true);
  assert.equal(r1.roundActive, true);
  assert.equal(r1.pendingNewRound, false);

  // Successive text deltas inside the same round
  state = { roundActive: r1.roundActive, pendingNewRound: r1.pendingNewRound };
  const r2 = shouldStartRound(state, "text");
  assert.equal(r2.start, false);
  assert.equal(r2.roundActive, true);

  // Tool execution triggers next round pending
  state = { roundActive: r2.roundActive, pendingNewRound: r2.pendingNewRound };
  const r3 = shouldStartRound(state, "tool");
  assert.equal(r3.start, false);
  assert.equal(r3.roundActive, false);
  assert.equal(r3.pendingNewRound, true);

  // Next text delta starts a new round
  state = { roundActive: r3.roundActive, pendingNewRound: r3.pendingNewRound };
  const r4 = shouldStartRound(state, "text");
  assert.equal(r4.start, true);
  assert.equal(r4.roundActive, true);
});

test("OpenCode driver: summarizeToolInput formats correctly", () => {
  assert.equal(summarizeToolInput("Bash", { command: "git status" }), "git status");
  assert.equal(summarizeToolInput("Read", { path: "src/index.ts" }), "src/index.ts");
  assert.equal(summarizeToolInput("Edit", { file_path: "src/index.ts" }), "src/index.ts");
  assert.equal(summarizeToolInput("Grep", { query: "export function" }), "export function");
  assert.equal(summarizeToolInput("custom", "plain string input"), "plain string input");
  assert.equal(summarizeToolInput("none", null), "");
});

test("OpenCode driver: resolveOpenCodeExecutable returns fallback or path", () => {
  const exe = resolveOpenCodeExecutable("/bin/sh");
  assert.equal(exe, "/bin/sh");
  const autoExe = resolveOpenCodeExecutable();
  assert.ok(typeof autoExe === "string" && autoExe.length > 0);
});

/** Fresh parse context matching what runOpenCode maintains. */
function mkCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "",
    roundActive: false,
    pendingNewRound: true,
    toolNames: new Map<string, string>(),
    lastRoundText: "",
    emittedToolParts: new Set<string>(),
    emittedToolResults: new Set<string>(),
    ...overrides,
  };
}

test("OpenCode driver: parseOpenCodeJsonEvent captures real sessionID without emitting init", () => {
  // The DRIVER owns init emission (one per distinct id, from real events only);
  // the parser just surfaces the id. Real shape: step_start carries sessionID.
  const ctx = mkCtx();
  const res = parseOpenCodeJsonEvent(
    { type: "step_start", timestamp: 1788397190989, sessionID: "ses_f9b38a4d2ffeZ1rV0jipwztSon", part: { id: "prt_1", type: "step-start" } },
    ctx,
  );
  assert.equal(res.sessionId, "ses_f9b38a4d2ffeZ1rV0jipwztSon");
  assert.equal(res.driverEvents.length, 0, "no init from the parser");
});

test("OpenCode driver: parses real-format text part and accumulates lastRoundText", () => {
  const ctx = mkCtx();
  const res = parseOpenCodeJsonEvent(
    { type: "text", timestamp: 1788397191560, sessionID: "ses_1", part: { id: "prt_2", type: "text", text: "好的", time: {} } },
    ctx,
  );
  assert.equal(res.deltaText, "好的");
  assert.equal(ctx.lastRoundText, "好的");
  assert.equal(res.driverEvents.length, 2); // roundStart + text
  assert.deepEqual(res.driverEvents[1], { kind: "text", delta: "好的" });
});

test("OpenCode driver: parses real-format tool_use part with state input/output", () => {
  const ctx = mkCtx({ lastRoundText: "thinking text" });
  const res = parseOpenCodeJsonEvent(
    {
      type: "tool_use", timestamp: 1788397341290, sessionID: "ses_1",
      part: {
        type: "tool", tool: "bash", callID: "call_7464",
        state: { status: "completed", input: { command: "ls" }, output: "(no output)", title: "ls" },
      },
    },
    ctx,
  );
  assert.deepEqual(res.driverEvents, [
    { kind: "tool", name: "bash", summary: "ls" },
    { kind: "toolResult", name: "bash", content: "(no output)", isError: false },
  ]);
  assert.equal(ctx.lastRoundText, "", "tool boundary resets the round text");
  assert.equal(ctx.toolNames.get("call_7464"), "bash");
});

test("OpenCode driver: dedupes repeated tool part deliveries (pending → completed)", () => {
  const ctx = mkCtx();
  const part = {
    type: "tool", tool: "bash", callID: "call_1",
    state: { status: "completed", input: { command: "ls" }, output: "file.txt" },
  };
  const first = parseOpenCodeJsonEvent({ type: "tool_use", sessionID: "ses_1", part }, ctx);
  const second = parseOpenCodeJsonEvent({ type: "tool_use", sessionID: "ses_1", part }, ctx);
  assert.equal(first.driverEvents.filter((e) => e.kind === "tool").length, 1);
  assert.equal(first.driverEvents.filter((e) => e.kind === "toolResult").length, 1);
  assert.deepEqual(second.driverEvents, [], "same part id delivered twice emits nothing");
});

test("OpenCode driver: step_finish stop yields done with lastRoundText, tokens and cost", () => {
  const ctx = mkCtx({ firstTimestamp: 1788397190989, lastTimestamp: 1788397195626 });
  ctx.lastRoundText = "当前目录有 0 个文件。";
  const res = parseOpenCodeJsonEvent(
    {
      type: "step_finish", timestamp: 1788397195626, sessionID: "ses_1",
      part: { type: "step-finish", reason: "stop", tokens: { total: 18641, input: 18593, output: 23, reasoning: 25, cache: { write: 0, read: 0 } }, cost: 0 },
    },
    ctx,
  );
  assert.equal(res.isDone, true);
  assert.equal(res.costUsd, 0);
  assert.deepEqual(res.usage, { inputTokens: 18593, outputTokens: 48 }, "output includes reasoning tokens");
  assert.equal(res.durationMs, 1788397195626 - 1788397190989);
  assert.deepEqual(res.driverEvents[0], {
    kind: "done",
    text: "当前目录有 0 个文件。",
    isError: false,
    aborted: false,
    costUsd: 0,
    durationMs: 1788397195626 - 1788397190989,
    usage: { inputTokens: 18593, outputTokens: 48 },
  });
});

test("OpenCode driver: step_finish with reason tool-calls is not done", () => {
  const ctx = mkCtx();
  const res = parseOpenCodeJsonEvent(
    {
      type: "step_finish", timestamp: 1788397341350, sessionID: "ses_1",
      part: { type: "step-finish", reason: "tool-calls", tokens: { input: 18540, output: 11 }, cost: 0 },
    },
    ctx,
  );
  assert.equal(res.isDone, false);
  assert.equal(res.driverEvents.length, 0);
  assert.deepEqual(res.usage, { inputTokens: 18540, outputTokens: 11 }, "usage still recorded for intermediate steps");
});

test("OpenCode driver: end-to-end real event stream produces the right events in order", () => {
  const ctx = mkCtx();
  const lines = [
    { type: "step_start", timestamp: 1788397190989, sessionID: "ses_f9b38a4d2ffeZ1rV0jipwztSon", part: { type: "step-start" } },
    { type: "text", timestamp: 1788397191560, sessionID: "ses_f9b38a4d2ffeZ1rV0jipwztSon", part: { type: "text", text: "好的" } },
    { type: "step_finish", timestamp: 1788397191626, sessionID: "ses_f9b38a4d2ffeZ1rV0jipwztSon", part: { type: "step-finish", reason: "stop", tokens: { input: 18519, output: 5 }, cost: 0 } },
  ];
  let roundActive = false;
  let pendingNewRound = true;
  let sessionId = "";
  const driverEvents: string[] = [];
  for (const line of lines) {
    ctx.roundActive = roundActive;
    ctx.pendingNewRound = pendingNewRound;
    const res = parseOpenCodeJsonEvent(line as never, ctx);
    roundActive = res.roundActive;
    pendingNewRound = res.pendingNewRound;
    sessionId = res.sessionId ?? sessionId;
    driverEvents.push(...res.driverEvents.map((e) => e.kind));
  }
  assert.equal(sessionId, "ses_f9b38a4d2ffeZ1rV0jipwztSon", "real session id captured");
  assert.deepEqual(driverEvents, ["roundStart", "text", "done"]);
});

test("OpenCode driver: legacy shapes still parse (session, tool_call/tool_result, result)", () => {
  const ctx = mkCtx();
  const ses = parseOpenCodeJsonEvent({ type: "session", sessionID: "ses_old" }, ctx);
  assert.equal(ses.sessionId, "ses_old");
  assert.equal(ses.driverEvents.length, 0);

  const call = parseOpenCodeJsonEvent(
    { type: "tool_call", tool: "Bash", tool_use_id: "call_1", input: { command: "ls -la" } },
    { ...ctx, roundActive: true, pendingNewRound: false },
  );
  assert.deepEqual(call.driverEvents[0], { kind: "tool", name: "Bash", summary: "ls -la" });
  assert.equal(ctx.toolNames.get("call_1"), "Bash");

  const result = parseOpenCodeJsonEvent(
    { type: "tool_result", tool_use_id: "call_1", output: "total 0", is_error: false },
    { ...ctx, roundActive: true, pendingNewRound: false },
  );
  assert.deepEqual(result.driverEvents, [
    { kind: "toolResult", name: "Bash", content: "total 0", isError: false },
  ]);

  const done = parseOpenCodeJsonEvent(
    { type: "result", result: "Task finished", cost: 0.005, duration_ms: 1200, usage: { input_tokens: 150, output_tokens: 50 } },
    ctx,
  );
  assert.equal(done.isDone, true);
  assert.equal(done.costUsd, 0.005);
  assert.equal(done.durationMs, 1200);
  assert.deepEqual(done.usage, { inputTokens: 150, outputTokens: 50 });
  assert.equal(done.driverEvents[0] && (done.driverEvents[0] as { text?: string }).text, "Task finished");
});

test("OpenCode driver: legacy delta shapes (thinking/text) still parse", () => {
  const ctx = mkCtx();
  const think = parseOpenCodeJsonEvent({ type: "thinking", delta: "analyzing codebase" }, ctx);
  assert.deepEqual(think.driverEvents, [
    { kind: "roundStart" },
    { kind: "thinking", delta: "analyzing codebase" },
  ]);
  const text = parseOpenCodeJsonEvent(
    { type: "text", delta: "Hello from OpenCode" },
    { ...ctx, roundActive: think.roundActive, pendingNewRound: think.pendingNewRound },
  );
  assert.equal(text.driverEvents.length, 1);
  assert.deepEqual(text.driverEvents[0], { kind: "text", delta: "Hello from OpenCode" });
  assert.equal(text.deltaText, "Hello from OpenCode");
});
