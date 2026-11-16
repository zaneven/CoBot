import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flattenDshPrompt,
  formatDshError,
  mapDshUpdate,
  newRunState,
  dshContextUsagePct,
  dshFinalText,
  buildDshEnv,
  resolveModelSelection,
  acpToolResultText,
  probeDshExecutable,
} from "./driver.js";
import { mapDshModelValue, normalizeDshModelId, parseDshModelTuple, collectDshModelIds } from "./models.js";
import type { AcpConfigOption, AcpSessionUpdate } from "./types.js";
import type { MediaAttachment } from "../claude/types.js";

const update = (u: AcpSessionUpdate): AcpSessionUpdate => u;

test("dsh: model value encoding round-trips provider/model ids", () => {
  assert.equal(mapDshModelValue("deepseek-official/deepseek-v4-pro"), '["deepseek-official","deepseek-v4-pro"]');
  assert.equal(mapDshModelValue('["deepseek-account","deepseek-flash"]'), '["deepseek-account","deepseek-flash"]');
  // Bare name → default provider route.
  assert.equal(mapDshModelValue("deepseek-flash"), '["deepseek-official","deepseek-flash"]');
  assert.equal(normalizeDshModelId('["deepseek-official","deepseek-v4-pro"]'), "deepseek-official/deepseek-v4-pro");
  assert.equal(normalizeDshModelId("deepseek-v4-pro"), "deepseek-v4-pro");
  assert.deepEqual(parseDshModelTuple('["p","m"]'), ["p", "m"]);
  assert.equal(parseDshModelTuple("nope"), undefined);
  assert.equal(parseDshModelTuple('["only-one"]'), undefined);
});

test("dsh: resolveModelSelection prefers an advertised value over re-encoding", () => {
  const options: AcpConfigOption[] = [
    {
      id: "model",
      type: "select",
      currentValue: '["deepseek-official","deepseek-v4-flash"]',
      options: [
        {
          group: "deepseek-official",
          name: "DeepSeek",
          options: [
            { value: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash" },
            { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
          ],
        },
      ],
    },
  ];
  // Bare name matches a grouped entry's advertised tuple.
  assert.equal(resolveModelSelection("deepseek-v4-pro", options), '["deepseek-official","deepseek-v4-pro"]');
  // provider/model spelling also matches.
  assert.equal(
    resolveModelSelection("deepseek-official/deepseek-v4-flash", options),
    '["deepseek-official","deepseek-v4-flash"]',
  );
  // Unknown id still gets encoded (the runtime rejects it; the driver logs).
  assert.equal(resolveModelSelection("mystery", options), '["deepseek-official","mystery"]');
  assert.equal(resolveModelSelection(undefined, options), undefined);
});

test("dsh: collectDshModelIds flattens grouped catalogs and dedupes", () => {
  const options: AcpConfigOption[] = [
    {
      id: "model",
      type: "select",
      options: [
        {
          group: "deepseek-official",
          name: "DeepSeek",
          options: [
            { value: '["deepseek-official","deepseek-flash"]', name: "DeepSeek-V4.1-Flash" },
            { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
          ],
        },
      ],
    },
  ];
  const { models, notes } = collectDshModelIds(options);
  assert.deepEqual(models, ["deepseek-official/deepseek-flash", "deepseek-official/deepseek-v4-pro"]);
  assert.equal(notes.length, 1);
});

test("dsh: prompt flattening inlines text files and reports unsupported media", () => {
  const text: MediaAttachment = {
    kind: "text",
    mediaType: "text/plain",
    fileName: "notes.txt",
    data: Buffer.from("hello world"),
  };
  const out = flattenDshPrompt("look at this", [text]);
  assert.ok(out.startsWith("look at this"));
  assert.ok(out.includes("notes.txt"));
  assert.ok(out.includes("hello world"));

  const img: MediaAttachment = { kind: "image", mediaType: "image/png", data: Buffer.from("x"), fileName: "a.png" };
  const out2 = flattenDshPrompt("see image", [img]);
  // The model is told the image did not arrive rather than silently losing it.
  assert.ok(out2.includes("不支持图片"));
  assert.equal(flattenDshPrompt("", []), "");
});

test("dsh: formatDshError maps credential/quota/rate-limit errors", () => {
  assert.ok(formatDshError("llm-deepseek: no API key for provider route").includes("缺少凭据"));
  assert.ok(formatDshError('{"code":"AUTH","status":401}').includes("401"));
  assert.ok(formatDshError("QUOTA exceeded").includes("额度"));
  assert.ok(formatDshError("RATE_LIMIT 429").includes("限流"));
  assert.equal(formatDshError("some other failure"), "some other failure");
  assert.ok(formatDshError("").length > 0);
});

test("dsh: agent messages open a round and accumulate the last round text", () => {
  const state = newRunState();
  const first = mapDshUpdate(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } }), state);
  assert.deepEqual(first, [{ kind: "roundStart" }, { kind: "text", delta: "hello " }]);
  const second = mapDshUpdate(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } }), state);
  // Same round: no second roundStart.
  assert.deepEqual(second, [{ kind: "text", delta: "world" }]);
  assert.equal(state.lastRoundText, "hello world");
  assert.equal(dshFinalText(state), "hello world");
});

test("dsh: a tool call closes the round so the answer after it starts fresh", () => {
  const state = newRunState();
  mapDshUpdate(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "planning…" } }), state);
  const toolEvents = mapDshUpdate(
    update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "echo hi" } }),
    state,
  );
  assert.ok(toolEvents.some((e) => e.kind === "tool" && e.name === "bash"));
  assert.ok(toolEvents.some((e) => e.kind === "tool" && "summary" in e && e.summary === "echo hi"));
  const after = mapDshUpdate(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }), state);
  assert.deepEqual(after, [{ kind: "roundStart" }, { kind: "text", delta: "done" }]);
  assert.equal(state.lastRoundText, "done");
});

test("dsh: tool results carry text and error status; intermediate statuses are ignored", () => {
  const state = newRunState();
  mapDshUpdate(update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "x" } }), state);
  // in_progress is not a result
  assert.deepEqual(mapDshUpdate(update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" }), state), []);
  const done = mapDshUpdate(
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "COBOT_DSH_OK\n" } }],
    }),
    state,
  );
  assert.deepEqual(done, [{ kind: "toolResult", name: "bash", content: "COBOT_DSH_OK", isError: false }]);
  const failed = mapDshUpdate(update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" }), state);
  assert.deepEqual(failed, [{ kind: "toolResult", name: "bash", content: "(error)", isError: true }]);
});

test("dsh: todo_write updates feed the task panel", () => {
  const state = newRunState();
  const events = mapDshUpdate(
    update({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "todo_write",
      rawInput: {
        todos: [
          { content: "step one", status: "in_progress" },
          { content: "step two", status: "pending" },
        ],
      },
    }),
    state,
  );
  const todos = events.find((e) => e.kind === "todos");
  assert.ok(todos && todos.kind === "todos");
  assert.equal(todos.todos.length, 2);
  assert.equal(todos.todos[0]!.status, "in_progress");
});

test("dsh: thought chunks map to thinking events", () => {
  const state = newRunState();
  const events = mapDshUpdate(update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }), state);
  assert.deepEqual(events, [{ kind: "roundStart" }, { kind: "thinking", delta: "hmm" }]);
});

test("dsh: usage_update drives the context percentage", () => {
  const state = newRunState();
  assert.equal(dshContextUsagePct(state), undefined);
  mapDshUpdate(update({ sessionUpdate: "usage_update", used: 17655, size: 1048576 }), state);
  assert.equal(dshContextUsagePct(state), 2);
  mapDshUpdate(update({ sessionUpdate: "usage_update", used: undefined, size: undefined }), state);
  assert.equal(dshContextUsagePct(state), 2, "partial updates keep the last known pair");
});

test("dsh: empty and unknown updates produce nothing", () => {
  const state = newRunState();
  assert.deepEqual(mapDshUpdate(update({ sessionUpdate: "agent_message_chunk", content: { text: "" } }), state), []);
  assert.deepEqual(mapDshUpdate(update({ sessionUpdate: "unknown/thing" }), state), []);
  assert.equal(acpToolResultText(update({ sessionUpdate: "tool_call_update" })), "");
});

test("dsh: env carries the proxy and the sandbox preset", () => {
  const env = buildDshEnv({ permissionMode: "workspace-write", proxyUrl: "http://127.0.0.1:10808", baseEnv: {} });
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:10808");
  assert.equal(env.DSH_PERMISSION_MODE, "workspace-write");
  assert.equal(env.NO_COLOR, "1");
  // An explicit empty proxy means direct (no inherited var wins).
  const direct = buildDshEnv({ proxyUrl: "", baseEnv: { HTTPS_PROXY: "http://keep:1" } });
  assert.equal(direct.HTTPS_PROXY, "http://keep:1");
});

test("dsh: probeDshExecutable rejects a nonexistent binary", async () => {
  assert.equal(await probeDshExecutable("/definitely/not/here/dsh"), false);
});
