import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAGyEvent,
  resolveAGyExecutable,
} from "./driver.js";
import { summarizeToolInput } from "../opencode/driver.js";

/** Fresh parse context matching what runAGy maintains. */
function mkCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "",
    roundActive: false,
    pendingNewRound: true,
    lastRoundText: "",
    emittedToolParts: new Set<number>(),
    emittedToolResults: new Set<number>(),
    ...overrides,
  };
}

test("AGy driver: resolveAGyExecutable returns fallback or path", () => {
  const exe = resolveAGyExecutable("/bin/sh");
  assert.equal(exe, "/bin/sh");
  const autoExe = resolveAGyExecutable();
  assert.ok(typeof autoExe === "string" && autoExe.length > 0);
});

test("AGy driver: summarizeToolInput (shared with opencode) formats correctly", () => {
  assert.equal(summarizeToolInput("run_command", { command: "git status" }), "git status");
  assert.equal(summarizeToolInput("write_to_file", { path: "src/index.ts" }), "src/index.ts");
  assert.equal(summarizeToolInput("Read", { file_path: "src/index.ts" }), "src/index.ts");
  assert.equal(summarizeToolInput("Grep", { query: "export function" }), "export function");
  assert.equal(summarizeToolInput("none", null), "");
});

test("AGy driver: parseAGyEvent captures conversation_id without emitting init", () => {
  // The DRIVER owns init emission; the parser just surfaces the id.
  const ctx = mkCtx();
  const res = parseAGyEvent(
    {
      event: "init",
      conversation_id: "3568d0a5-bcbe-4f7c-b824-cc5aa4fb7876",
      init: { cwd: "/tmp/proj", tools: ["write_to_file"], permission_mode: "always-proceed" },
    },
    ctx,
  );
  assert.equal(res.sessionId, "3568d0a5-bcbe-4f7c-b824-cc5aa4fb7876");
  assert.equal(res.driverEvents.length, 0, "no init from the parser");
});

test("AGy driver: step_update user_input is skipped", () => {
  const ctx = mkCtx();
  const res = parseAGyEvent(
    {
      event: "step_update",
      step_update: { conversation_id: "c1", step_index: 0, state: "DONE", step_type: "user_input" },
    },
    ctx,
  );
  assert.equal(res.driverEvents.length, 0);
  assert.equal(res.isDone, false);
});

test("AGy driver: step_update agent_response text_delta accumulates lastRoundText", () => {
  const ctx = mkCtx({ sessionId: "c1" });
  const res = parseAGyEvent(
    {
      event: "step_update",
      step_update: { conversation_id: "c1", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "ok" },
    },
    ctx,
  );
  assert.equal(res.deltaText, "ok");
  assert.equal(ctx.lastRoundText, "ok");
  assert.equal(res.driverEvents.length, 2); // roundStart + text
  assert.deepEqual(res.driverEvents[1], { kind: "text", delta: "ok" });
});

test("AGy driver: thinking step emits thinking delta", () => {
  const ctx = mkCtx();
  const res = parseAGyEvent(
    {
      event: "step_update",
      step_update: { conversation_id: "c1", step_index: 1, state: "ACTIVE", step_type: "thinking", text_delta: "let me think" },
    },
    ctx,
  );
  assert.deepEqual(res.driverEvents, [
    { kind: "roundStart" },
    { kind: "thinking", delta: "let me think" },
  ]);
});

test("AGy driver: tool ACTIVE emits tool, DONE emits toolResult", () => {
  const ctx = mkCtx({ lastRoundText: "intermediate text" });
  const active = parseAGyEvent(
    {
      event: "step_update",
      step_update: {
        conversation_id: "c1", step_index: 2, state: "ACTIVE", step_type: "tool",
        tool_name: "write_to_file",
        tool_info: { name: "write_to_file", parameters: { TargetFile: "/tmp/hello.txt" } },
      },
    },
    ctx,
  );
  assert.deepEqual(active.driverEvents, [
    { kind: "tool", name: "write_to_file", summary: '{"TargetFile":"/tmp/hello.txt"}' },
  ]);
  assert.equal(ctx.lastRoundText, "", "tool boundary resets the round text");

  const done = parseAGyEvent(
    {
      event: "step_update",
      step_update: {
        conversation_id: "c1", step_index: 2, state: "DONE", step_type: "tool",
        tool_name: "write_to_file",
        tool_info: { name: "write_to_file", parameters: { TargetFile: "/tmp/hello.txt" } },
        duration_seconds: 0.062,
      },
    },
    ctx,
  );
  assert.deepEqual(done.driverEvents, [
    { kind: "toolResult", name: "write_to_file", content: "(completed)", isError: false },
  ]);
});

test("AGy driver: dedupes repeated tool step deliveries by step_index", () => {
  const ctx = mkCtx();
  const ev = {
    event: "step_update",
    step_update: {
      conversation_id: "c1", step_index: 2, state: "ACTIVE", step_type: "tool",
      tool_name: "run_command", tool_info: { name: "run_command", parameters: { command: "ls" } },
    },
  };
  const first = parseAGyEvent(ev, ctx);
  const second = parseAGyEvent(ev, ctx);
  assert.equal(first.driverEvents.filter((e) => e.kind === "tool").length, 1);
  assert.deepEqual(second.driverEvents, [], "same step_index delivered twice emits nothing");
});

test("AGy driver: result event yields done with usage, duration and final text", () => {
  const ctx = mkCtx({ lastRoundText: "final answer" });
  const res = parseAGyEvent(
    {
      event: "result",
      result: {
        conversation_id: "c1", status: "SUCCESS", response: "final answer",
        duration_seconds: 6.556, num_turns: 1,
        usage: { input_tokens: 23876, output_tokens: 956, thinking_tokens: 832, cache_read_tokens: 16293, total_tokens: 24832 },
      },
    },
    ctx,
  );
  assert.equal(res.isDone, true);
  assert.deepEqual(res.usage, { inputTokens: 23876, outputTokens: 1788 }, "output includes thinking tokens");
  assert.equal(res.durationMs, Math.round(6.556 * 1000));
  assert.deepEqual(res.driverEvents[0], {
    kind: "done",
    text: "final answer",
    isError: false,
    aborted: false,
    usage: { inputTokens: 23876, outputTokens: 1788 },
    durationMs: Math.round(6.556 * 1000),
  });
});

test("AGy driver: result event with ERROR status sets isError", () => {
  const ctx = mkCtx();
  const res = parseAGyEvent(
    { event: "result", result: { conversation_id: "c1", status: "ERROR", response: "boom" } },
    ctx,
  );
  assert.equal(res.isDone, true);
  assert.equal(res.driverEvents[0] && (res.driverEvents[0] as { isError?: boolean }).isError, true);
});

test("AGy driver: tool ERROR emits toolResult with isError=true and error message", () => {
  const ctx = mkCtx();
  const res = parseAGyEvent(
    {
      event: "step_update",
      step_update: {
        conversation_id: "c1",
        step_index: 5,
        state: "ERROR",
        step_type: "tool",
        tool_name: "list_dir",
        tool_info: {
          name: "list_dir",
          parameters: { DirectoryPath: "/protected" },
          error: { type: "TOOL_ERROR", message: "Permission denied for read_file" },
        },
      },
    },
    ctx,
  );
  assert.equal(res.driverEvents.length, 1);
  assert.deepEqual(res.driverEvents[0], {
    kind: "toolResult",
    name: "list_dir",
    content: "Permission denied for read_file",
    isError: true,
  });
  assert.ok(ctx.emittedToolResults.has(5));
});

test("AGy driver: tool DONE preserves tool_info.output", () => {
  const ctx = mkCtx();
  const res = parseAGyEvent(
    {
      event: "step_update",
      step_update: {
        conversation_id: "c1",
        step_index: 6,
        state: "DONE",
        step_type: "tool",
        tool_name: "list_dir",
        tool_info: {
          name: "list_dir",
          parameters: { DirectoryPath: "/tmp" },
          output: "file1.txt\nfile2.txt",
        },
      },
    },
    ctx,
  );
  assert.equal(res.driverEvents.length, 1);
  assert.deepEqual(res.driverEvents[0], {
    kind: "toolResult",
    name: "list_dir",
    content: "file1.txt\nfile2.txt",
    isError: false,
  });
});

test("AGy driver: parseAGyEvent captures conversation_id from step_update or result", () => {
  const ctx = mkCtx();
  const resStep = parseAGyEvent(
    {
      event: "step_update",
      step_update: {
        conversation_id: "from-step-uuid",
        step_index: 0,
        state: "DONE",
        step_type: "user_input",
      },
    },
    ctx,
  );
  assert.equal(resStep.sessionId, "from-step-uuid");
  assert.equal(ctx.sessionId, "from-step-uuid");

  const ctx2 = mkCtx();
  const resRes = parseAGyEvent(
    {
      event: "result",
      result: {
        conversation_id: "from-result-uuid",
        status: "SUCCESS",
        response: "ok",
      },
    },
    ctx2,
  );
  assert.equal(resRes.sessionId, "from-result-uuid");
  assert.equal(ctx2.sessionId, "from-result-uuid");
});

test("AGy driver: error event surfaces message and sets isDone", () => {
  const ctx = mkCtx();
  const res = parseAGyEvent({ event: "error", message: "permission denied" }, ctx);
  assert.equal(res.isDone, true);
  assert.deepEqual(res.driverEvents, [{ kind: "error", message: "permission denied" }]);
});

test("AGy driver: end-to-end real captured stream produces the right events in order", () => {
  // Real NDJSON captured from `agy --print "create a file named hello.txt..."`.
  const lines = [
    { event: "init", conversation_id: "a46e5ccb-53a0-4fc2-9d0d-c5e0c455c6aa", init: { cwd: "/tmp/p", tools: ["write_to_file"], permission_mode: "always-proceed" } },
    { event: "step_update", step_update: { conversation_id: "a46e5ccb-53a0-4fc2-9d0d-c5e0c455c6aa", step_index: 0, state: "DONE", step_type: "user_input" } },
    { event: "step_update", step_update: { conversation_id: "a46e5ccb-53a0-4fc2-9d0d-c5e0c455c6aa", step_index: 1, state: "DONE", step_type: "agent_response", duration_seconds: 4.286, usage: { input_tokens: 19651, output_tokens: 742, thinking_tokens: 660 } } },
    { event: "step_update", step_update: { conversation_id: "a46e5ccb-53a0-4fc2-9d0d-c5e0c455c6aa", step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: { TargetFile: "/tmp/hello.txt" } } } },
    { event: "step_update", step_update: { conversation_id: "a46e5ccb-53a0-4fc2-9d0d-c5e0c455c6aa", step_index: 2, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: { TargetFile: "/tmp/hello.txt" } }, duration_seconds: 0.06 } },
    { event: "step_update", step_update: { conversation_id: "a46e5ccb-53a0-4fc2-9d0d-c5e0c455c6aa", step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "已为您创建文件" } },
    { event: "step_update", step_update: { conversation_id: "a46e5ccb-53a0-4fc2-9d0d-c5e0c455c6aa", step_index: 3, state: "DONE", step_type: "agent_response", text_delta: " hello.txt", duration_seconds: 2.2, usage: { input_tokens: 4225, output_tokens: 214, thinking_tokens: 172 } } },
    { event: "result", result: { conversation_id: "a46e5ccb-53a0-4fc2-9d0d-c5e0c455c6aa", status: "SUCCESS", response: "已为您创建文件 hello.txt", duration_seconds: 6.556, num_turns: 1, usage: { input_tokens: 23876, output_tokens: 956, thinking_tokens: 832, total_tokens: 24832 } } },
  ];
  const ctx = mkCtx();
  let roundActive = false;
  let pendingNewRound = true;
  const driverEvents: string[] = [];
  for (const line of lines) {
    ctx.roundActive = roundActive;
    ctx.pendingNewRound = pendingNewRound;
    const res = parseAGyEvent(line as never, ctx);
    roundActive = res.roundActive;
    pendingNewRound = res.pendingNewRound;
    driverEvents.push(...res.driverEvents.map((e) => e.kind));
  }
  assert.equal(ctx.sessionId, "a46e5ccb-53a0-4fc2-9d0d-c5e0c455c6aa", "real conversation id captured");
  assert.deepEqual(driverEvents, [
    "tool", "toolResult", "roundStart", "text", "text", "done",
  ]);
});
