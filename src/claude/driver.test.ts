import { test } from "node:test";
import assert from "node:assert/strict";
import type { PromptInput } from "./types.js";
import { buildSdkPrompt, parseContextFromModelId, computeContextUsagePct, mapContentBlockDelta, buildPermissionRequest, toSdkPermissionResult, shouldStartRound, isMaxTurnsResult, parseTodos } from "./driver.js";
import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };

function build(input: PromptInput): string | AsyncIterable<any> {
  return buildSdkPrompt(input);
}

async function collect(it: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const v of it) out.push(v);
  return out;
}

test("no media -> raw string (fast path)", () => {
  const r = build({ text: "hello" });
  assert.equal(typeof r, "string");
  assert.equal(r, "hello");
});

test("no media with empty text -> empty string", () => {
  assert.equal(build({ text: "" }), "");
});

test("with image -> one user message, text block then image block, base64 data", async () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // dummy jpeg bytes
  const r = await collect(
    build({ text: "see this", media: [{ kind: "image", mediaType: "image/jpeg", data: buf }] }) as AsyncIterable<any>,
  );
  assert.equal(r.length, 1);
  assert.equal(r[0]!.type, "user");
  assert.equal(r[0]!.message.role, "user");
  const blocks = r[0]!.message.content as Block[];
  assert.deepEqual(blocks[0]!, { type: "text", text: "see this" });
  assert.equal(blocks[1]!.type, "image");
  assert.equal(blocks[1]!.source!.type, "base64");
  assert.equal(blocks[1]!.source!.media_type, "image/jpeg");
  assert.equal(blocks[1]!.source!.data, buf.toString("base64"));
});

test("pdf -> document block with application/pdf", async () => {
  const buf = Buffer.from("%PDF-1.4");
  const r = await collect(
    build({ text: "", media: [{ kind: "pdf", data: buf }] }) as AsyncIterable<any>,
  );
  const blocks = r[0]!.message.content as Block[];
  assert.equal(blocks[0]!.type, "document", "empty text yields no text block, just the document");
  assert.equal(blocks[0]!.source!.media_type, "application/pdf");
});

test("text file -> inlined fenced text block, truncated past limit", async () => {
  const big = "x".repeat(210_000);
  const buf = Buffer.from(big, "utf8");
  const r = await collect(
    build({ text: "review this", media: [{ kind: "text", mediaType: "text/plain", data: buf, fileName: "log.txt" }] }) as AsyncIterable<any>,
  );
  const blocks = r[0]!.message.content as Block[];
  assert.deepEqual(blocks[0]!, { type: "text", text: "review this" });
  assert.equal(blocks[1]!.type, "text");
  assert.ok(blocks[1]!.text!.startsWith("📎 log.txt (text/plain)"));
  assert.ok(blocks[1]!.text!.includes("[truncated]"));
  assert.ok(blocks[1]!.text!.length < 220_000);
});

test("parseContextFromModelId: [1M] -> 1_048_576", () => {
  assert.equal(parseContextFromModelId("deepseek-ai/deepseek-v4-pro[1M]"), 1_048_576);
});

test("parseContextFromModelId: [500K] -> 512_000", () => {
  assert.equal(parseContextFromModelId("some-model[500K]"), 512_000);
});

test("parseContextFromModelId: [32K] -> 32_768", () => {
  assert.equal(parseContextFromModelId("claude-haiku-4-5[32K]"), 32_768);
});

test("parseContextFromModelId: [200K] -> 204_800", () => {
  assert.equal(parseContextFromModelId("claude-sonnet-4-5[200K]"), 204_800);
});

test("parseContextFromModelId: no bracket -> 0", () => {
  assert.equal(parseContextFromModelId("anthropic/claude-opus-5"), 0);
});

test("parseContextFromModelId: empty string -> 0", () => {
  assert.equal(parseContextFromModelId(""), 0);
});

// ─── computeContextUsagePct ────────────────────────────────────────────

function mu(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 200_000,
    maxOutputTokens: 4096,
    ...overrides,
  };
}

test("computeContextUsagePct: undefined -> undefined", () => {
  assert.equal(computeContextUsagePct(undefined), undefined);
});

test("computeContextUsagePct: empty record -> undefined", () => {
  assert.equal(computeContextUsagePct({}), undefined);
});

test("computeContextUsagePct: uses SDK-reported contextWindow when valid", () => {
  assert.equal(
    computeContextUsagePct({ "anthropic/claude-sonnet-5": mu({ contextWindow: 200_000, inputTokens: 5000 }) }),
    3, // 5000/200000*100 = 2.5 → 3
  );
});

test("computeContextUsagePct: zero contextWindow -> undefined", () => {
  assert.equal(
    computeContextUsagePct({ model: mu({ contextWindow: 0 }) }),
    undefined,
  );
});

test("computeContextUsagePct: fallback from record key suffix (third-party model)", () => {
  const record: Record<string, ModelUsage> = {
    "deepseek-ai/deepseek-v4-pro[1M]": mu({ contextWindow: 2000, inputTokens: 100_000 }),
  };
  // 100_000 / 1_048_576 * 100 ≈ 10
  assert.equal(computeContextUsagePct(record), 10);
});

test("computeContextUsagePct: fallback from canonicalModel suffix", () => {
  const record: Record<string, ModelUsage> = {
    "custom-model-alias": mu({ contextWindow: 2000, inputTokens: 100_000, canonicalModel: "some-model[500K]" }),
  };
  // 100_000 / 512_000 * 100 ≈ 20
  assert.equal(computeContextUsagePct(record), 20);
});

test("computeContextUsagePct: tiny window triggers fallback, no suffix → still computes raw", () => {
  // Fallback triggers (contextWindow < 2000) but no [NK] suffix anywhere —
  // the raw contextWindow is used as-is. Not great, but better than hiding
  // the problem with undefined.
  const record: Record<string, ModelUsage> = {
    "some-unknown-model": mu({ contextWindow: 1000, inputTokens: 100_000 }),
  };
  // 100_000 / 1000 * 100 = 10000
  assert.equal(computeContextUsagePct(record), 10000);
});

test("computeContextUsagePct: multi-model — takes max SDK window, skips fallback", () => {
  // When at least one model has a reasonable contextWindow, fallback is never triggered.
  const record: Record<string, ModelUsage> = {
    "deepseek-ai/deepseek-v4-pro[1M]": mu({ contextWindow: 2000, inputTokens: 50_000 }),
    "anthropic/claude-sonnet-5": mu({ contextWindow: 200_000, inputTokens: 10_000 }),
  };
  // totalTokens = 60_000, maxWindow = 200_000 → 30%
  assert.equal(computeContextUsagePct(record), 30);
});

test("computeContextUsagePct: all models tiny window, sums tokens, derives from suffix", () => {
  const record: Record<string, ModelUsage> = {
    "deepseek-ai/deepseek-v4-pro[1M]": mu({ contextWindow: 2000, inputTokens: 50_000 }),
    "gpt-5[128K]": mu({ contextWindow: 1000, inputTokens: 30_000 }),
  };
  // 80_000 / 1_048_576 ≈ 8%
  assert.equal(computeContextUsagePct(record), 8);
});

// ─── mapContentBlockDelta: thinking / text / ignored ─────────────────────

test("mapContentBlockDelta: thinking_delta → 'thinking' event", () => {
  const ev = mapContentBlockDelta({ type: "thinking_delta", thinking: "let me think" });
  assert.deepEqual(ev, { kind: "thinking", delta: "let me think" });
});

test("mapContentBlockDelta: text_delta → 'text' event", () => {
  const ev = mapContentBlockDelta({ type: "text_delta", text: "answer" });
  assert.deepEqual(ev, { kind: "text", delta: "answer" });
});

test("mapContentBlockDelta: empty thinking/text → null (no spurious event)", () => {
  assert.equal(mapContentBlockDelta({ type: "thinking_delta" }), null);
  assert.equal(mapContentBlockDelta({ type: "text_delta" }), null);
});

test("mapContentBlockDelta: signature_delta is ignored", () => {
  assert.equal(mapContentBlockDelta({ type: "signature_delta", thinking: "sig" }), null);
  assert.equal(mapContentBlockDelta({ type: "input_json_delta" } as any), null);
});

// ─── shouldStartRound: agentic-turn (round) boundaries ──────────────────

test("shouldStartRound: first text delta opens round 1", () => {
  const r = shouldStartRound({ roundActive: false, pendingNewRound: false }, "text");
  assert.deepEqual(r, { start: true, roundActive: true, pendingNewRound: false });
});

test("shouldStartRound: first thinking delta also opens a round", () => {
  const r = shouldStartRound({ roundActive: false, pendingNewRound: false }, "thinking");
  assert.deepEqual(r, { start: true, roundActive: true, pendingNewRound: false });
});

test("shouldStartRound: more text within the same round does NOT open a new one", () => {
  const r = shouldStartRound({ roundActive: true, pendingNewRound: false }, "text");
  assert.deepEqual(r, { start: false, roundActive: true, pendingNewRound: false });
});

test("shouldStartRound: a tool_use flags pendingNewRound (no round opened yet)", () => {
  const r = shouldStartRound({ roundActive: true, pendingNewRound: false }, "tool");
  assert.deepEqual(r, { start: false, roundActive: true, pendingNewRound: true });
});

test("shouldStartRound: text after a tool-using turn opens the next round", () => {
  const r = shouldStartRound({ roundActive: true, pendingNewRound: true }, "text");
  assert.deepEqual(r, { start: true, roundActive: true, pendingNewRound: false });
});

test("shouldStartRound: thinking after a tool-using turn also opens the next round", () => {
  const r = shouldStartRound({ roundActive: true, pendingNewRound: true }, "thinking");
  assert.deepEqual(r, { start: true, roundActive: true, pendingNewRound: false });
});

test("shouldStartRound: consecutive tool_use keeps pendingNewRound set", () => {
  const r = shouldStartRound({ roundActive: true, pendingNewRound: true }, "tool");
  assert.deepEqual(r, { start: false, roundActive: true, pendingNewRound: true });
});

// ─── canUseTool bridge mappers ─────────────────────────────────────────

test("buildPermissionRequest forwards SDK opts into a bot-layer request", () => {
  const req = buildPermissionRequest(
    "Bash",
    { command: "ls -la" },
    { requestId: "rq-1", toolUseID: "tu-1", title: "Claude wants to run Bash", displayName: "Run command", description: "d", suggestions: [] },
    "/cwd",
  );
  assert.equal(req.toolName, "Bash");
  assert.equal(req.requestId, "rq-1");
  assert.equal(req.toolUseID, "tu-1");
  assert.equal(req.title, "Claude wants to run Bash");
  assert.equal(req.displayName, "Run command");
  assert.deepEqual(req.input, { command: "ls -la" });
  assert.equal(req.cwd, "/cwd");
  assert.deepEqual(req.suggestions, []);
});

test("toSdkPermissionResult: allow carries updatedInput + updatedPermissions", () => {
  // No originalInput passed → updatedInput: undefined (unit-test path; the real
  // canUseTool wrapper always passes the tool's input).
  assert.deepEqual(toSdkPermissionResult({ behavior: "allow" }), { behavior: "allow", updatedInput: undefined, updatedPermissions: undefined });
  assert.deepEqual(
    toSdkPermissionResult({ behavior: "allow", updatedPermissions: [{ type: "addRules", rules: [], behavior: "allow", destination: "session" }] }),
    { behavior: "allow", updatedInput: undefined, updatedPermissions: [{ type: "addRules", rules: [], behavior: "allow", destination: "session" }] },
  );
});

test("toSdkPermissionResult: allow threads originalInput as updatedInput", () => {
  // Regression guard: the SDK's runtime Zod schema REQUIRES `updatedInput` (a
  // record) on an allow. Without it canUseTool's allow is rejected as a
  // permission error and the tool never runs ("the bot won't run Bash / write
  // files"). The original input means "allow, run unchanged".
  assert.deepEqual(
    toSdkPermissionResult({ behavior: "allow" }, { command: "node -e 'console.log(42)'" }),
    { behavior: "allow", updatedInput: { command: "node -e 'console.log(42)'" }, updatedPermissions: undefined },
  );
});

test("toSdkPermissionResult: deny carries message", () => {
  assert.deepEqual(toSdkPermissionResult({ behavior: "deny", message: "no" }), { behavior: "deny", message: "no" });
});

test("isMaxTurnsResult: error_max_turns is the max-turns terminal subtype", () => {
  assert.equal(isMaxTurnsResult("error_max_turns"), true);
  assert.equal(isMaxTurnsResult("error_during_execution"), false);
  assert.equal(isMaxTurnsResult("error_max_budget_usd"), false);
  assert.equal(isMaxTurnsResult("completed"), false);
  assert.equal(isMaxTurnsResult(undefined), false);
});

// ─── parseTodos: TodoWrite payload → TodoItem[] ─────────────────────────

test("parseTodos: parses a well-formed todo list, omitting empty activeForm", () => {
  const items = parseTodos({
    todos: [
      { content: "sync shared layer", status: "in_progress", activeForm: "syncing shared layer" },
      { content: "add tests", status: "pending", activeForm: "" },
      { content: "update docs", status: "completed" },
    ],
  });
  assert.deepEqual(items, [
    { content: "sync shared layer", status: "in_progress", activeForm: "syncing shared layer" },
    { content: "add tests", status: "pending" },
    { content: "update docs", status: "completed" },
  ]);
});

test("parseTodos: returns null for non-todo / malformed payloads", () => {
  assert.equal(parseTodos(null), null);
  assert.equal(parseTodos("nope"), null);
  assert.equal(parseTodos({ command: "ls" }), null);
  assert.equal(parseTodos({ todos: [] }), null);
  assert.equal(parseTodos({ todos: [{ content: "", status: "pending" }] }), null);
  assert.equal(parseTodos({ todos: [{ content: "x", status: "weird" }] }), null);
});

test("mapContentBlockDelta: sequences thinking then text across multiple deltas", () => {
  const deltas = [
    { type: "thinking_delta", thinking: "hmm, " },
    { type: "thinking_delta", thinking: "let me think" },
    { type: "text_delta", text: "answer" },
  ];
  const events = deltas.map((d) => mapContentBlockDelta(d)).filter(Boolean);
  assert.deepEqual(events, [
    { kind: "thinking", delta: "hmm, " },
    { kind: "thinking", delta: "let me think" },
    { kind: "text", delta: "answer" },
  ]);
});