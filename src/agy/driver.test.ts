import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAGyEvent,
  resolveAGyExecutable,
  sanitizeAGyText,
  AGyStreamSanitizer,
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

// ── Protocol Sanitization Tests ─────────────────────────────────────────────

test("sanitizeAGyText: removes complete <SYSTEM_MESSAGE>...</SYSTEM_MESSAGE>} blocks", () => {
  const input = "正在准备构建镜像...\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17\nOutput: logs\n</SYSTEM_MESSAGE>}\n在另一台电脑上测试。";
  const out = sanitizeAGyText(input);
  assert.equal(out, "正在准备构建镜像...\n\n在另一台电脑上测试。");
});

test("sanitizeAGyText: handles task completion notice without open tag", () => {
  const input = '[Message] timestamp=2026-09-17T03:07:31Z sender=task-187 priority=MESSAGE_PRIORITY_HIGH content=Task id "task-187" finished with result:\nThe command exited with code 0.\nTask output has been logged to: file:///task.log\n</SYSTEM_MESSAGE>}\n构建已完成。';
  const out = sanitizeAGyText(input);
  assert.equal(out, "构建已完成。");
});

test("sanitizeAGyText: handles real user reproduction snippet", () => {
  const input = `正在重新编译优化并生成适配不同外设的 Release DMG 镜像... [Message] timestamp=2026-09-17T03:07:31Z sender=454c6561-f68a-433a-95b9-4e89695e10f6/task-187 priority=MESSAGE_PRIORITY_HIGH content=Task id "454c6561-f68a-433a-95b9-4e89695e10f6/task-187" finished with result:
The command exited with code 0. Output: <truncated 82 lines>
ExecuteExternalTool /Applications/Xcode.app/...
BUILD SUCCEEDED
created: /Users/a1/Develop/RollBar/dist/RollBar.dmg
Task output has been logged to: file:///Users/a1/.gemini/antigravity-cli/brain/454c6561-f68a-433a-95b9-4e89695e10f6/.system_generated/tasks/task-187.log
</SYSTEM_MESSAGE>}在另一台电脑上安装 DMG 后出现「中键拖拽不好使」，通常由权限引起。`;

  const out = sanitizeAGyText(input);
  assert.ok(!out.includes("<SYSTEM_MESSAGE>"));
  assert.ok(!out.includes("</SYSTEM_MESSAGE"));
  assert.ok(!out.includes("task-187"));
  assert.ok(!out.includes("Task output has been logged to"));
  assert.ok(out.includes("正在重新编译优化并生成适配不同外设的 Release DMG 镜像..."));
  assert.ok(out.includes("在另一台电脑上安装 DMG 后出现「中键拖拽不好使」，通常由权限引起。"));
});

test("sanitizeAGyText: preserves clean text unchanged", () => {
  const normal = "这是一个普通的回答，包含一些 `code` 和 [链接](https://example.com)。";
  assert.equal(sanitizeAGyText(normal), normal);
});

test("AGyStreamSanitizer: hides <SYSTEM_MESSAGE> across chunk boundaries", () => {
  const sanitizer = new AGyStreamSanitizer();
  const chunks = [
    "第一句话，",
    "正在打包... <SYS",
    "TEM_MESSAGE>",
    "[Message] 内部日志内容",
    " 还有更多日志 </SYS",
    "TEM_MESSAGE>} 第二句话。",
  ];

  let output = "";
  for (const chunk of chunks) {
    output += sanitizer.feed(chunk);
  }
  output += sanitizer.flush();

  assert.ok(!output.includes("<SYSTEM_MESSAGE>"));
  assert.ok(!output.includes("内部日志内容"));
  assert.ok(!output.includes("</SYSTEM_MESSAGE"));
  assert.ok(output.includes("第一句话，"));
  assert.ok(output.includes("正在打包... "));
  assert.ok(output.includes("第二句话。"));
});

test("AGyStreamSanitizer: suppresses trailing unclosed system block on flush", () => {
  const sanitizer = new AGyStreamSanitizer();
  let output = sanitizer.feed("前文说明。\n<SYSTEM_MESSAGE>[Message] 还在运行，未闭合的日志...");
  output += sanitizer.flush();

  assert.equal(output.trim(), "前文说明。");
});

test("parseAGyEvent: cleans system message bleed from text_delta and result.response", () => {
  const ctx = mkCtx();
  const stepRes = parseAGyEvent(
    {
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "正在生成... <SYSTEM_MESSAGE>[Message] task done</SYSTEM_MESSAGE>} 正文内容。",
      },
      conversation_id: "test-c1",
    },
    ctx,
  );

  const textEv = stepRes.driverEvents.find((e) => e.kind === "text");
  assert.ok(textEv && textEv.kind === "text");
  assert.ok(!textEv.delta.includes("<SYSTEM_MESSAGE>"));
  assert.ok(!textEv.delta.includes("task done"));
  assert.ok(textEv.delta.includes("正在生成..."));
  assert.ok(textEv.delta.includes("正文内容。"));

  const finishRes = parseAGyEvent(
    {
      event: "result",
      result: {
        status: "SUCCESS",
        response: "<SYSTEM_MESSAGE>[Message] task done</SYSTEM_MESSAGE>} 最终总结交付。",
      },
      conversation_id: "test-c1",
    },
    ctx,
  );

  const doneEv = finishRes.driverEvents.find((e) => e.kind === "done");
  assert.ok(doneEv && doneEv.kind === "done");
  assert.equal(doneEv.text, "最终总结交付。");
});

