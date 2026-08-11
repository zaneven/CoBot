import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager, type ApprovalCtx } from "./approval.js";
import { Store } from "../store/db.js";
import type { PermissionRequest } from "../claude/types.js";

/** Fresh, unique requestId per request so instances never collide. */
function makeReq(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: `r-${Math.random().toString(36).slice(2)}`,
    toolUseID: "tu-1",
    toolName: "Bash",
    input: { command: "rm -rf /tmp/x" },
    cwd: "/proj",
    ...overrides,
  };
}

function makeApi() {
  const calls: { text: string; keyboard?: unknown }[] = [];
  const api = {
    sendMessage: async (_c: number, text: string, extra?: { reply_markup?: unknown }) => {
      calls.push({ text, keyboard: extra?.reply_markup });
      return { message_id: 1 };
    },
    editMessageText: async () => ({}),
    deleteMessage: async () => ({}),
  };
  return { api, calls };
}

/** Fresh ApprovalManager → first prompt's shortId is always 1, so the callback
 *  data for action X is `appr:1:X`. */
function cbData(action: "allow" | "deny" | "always"): string {
  return `appr:1:${action}`;
}

function fakeCtx(chatId: number, data: string, api: unknown) {
  return {
    callbackQuery: { data },
    chat: { id: chatId },
    api,
    answerCallbackQuery: async () => undefined,
  } as never;
}

function ctxFor(api: unknown, chatId = 1, overrides: Partial<ApprovalCtx> = {}): ApprovalCtx {
  return {
    api,
    chatId,
    indicator: { activity() {} } as never,
    mode: "interactive",
    skipTools: new Set(["Read"]),
    timeoutMs: 1000,
    timeoutAction: "allow",
    ...overrides,
  } as ApprovalCtx;
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ── policy short-circuits (no prompt) ──〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("auto mode → allow without prompting", async () => {
  const m = new ApprovalManager();
  m.init(new Store(":memory:"));
  const { api, calls } = makeApi();
  const dec = await m.request(makeReq(), ctxFor(api, 1, { mode: "auto" }), new AbortController().signal);
  assert.equal(dec.behavior, "allow");
  assert.equal(calls.length, 0);
});

test("skipTools (read-only) → allow without prompting", async () => {
  const m = new ApprovalManager();
  m.init(new Store(":memory:"));
  const { api, calls } = makeApi();
  const dec = await m.request(makeReq({ toolName: "Read" }), ctxFor(api), new AbortController().signal);
  assert.equal(dec.behavior, "allow");
  assert.equal(calls.length, 0);
});

test("always-allow rule in DB → allow without prompting", async () => {
  const store = new Store(":memory:");
  store.upsertBinding(1, "/p", null);
  store.addAlwaysAllow(1, "Bash");
  const m = new ApprovalManager();
  m.init(store);
  const { api, calls } = makeApi();
  const dec = await m.request(makeReq({ toolName: "Bash" }), ctxFor(api, 1), new AbortController().signal);
  assert.equal(dec.behavior, "allow");
  assert.equal(calls.length, 0);
});

// ── interactive prompt ──〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("interactive mutating tool → prompt, allow on tap", async () => {
  const m = new ApprovalManager();
  m.init(new Store(":memory:"));
  const { api, calls } = makeApi();
  const p = m.request(makeReq(), ctxFor(api, 1), new AbortController().signal);
  await tick();
  assert.equal(calls.length, 1);
  await m.handleCallback(fakeCtx(1, cbData("allow"), api));
  assert.equal((await p).behavior, "allow");
});

test("interactive prompt → deny on tap", async () => {
  const m = new ApprovalManager();
  m.init(new Store(":memory:"));
  const { api, calls } = makeApi();
  const p = m.request(makeReq(), ctxFor(api, 1), new AbortController().signal);
  await tick();
  await m.handleCallback(fakeCtx(1, cbData("deny"), api));
  const dec = await p;
  assert.equal(dec.behavior, "deny");
  assert.equal(dec.message, "用户拒绝");
});

test("always tap → allow + persists rule (next call skips prompt)", async () => {
  const store = new Store(":memory:");
  store.upsertBinding(1, "/p", null);
  const m = new ApprovalManager();
  m.init(store);
  const { api, calls } = makeApi();
  const p = m.request(makeReq({ toolName: "Bash" }), ctxFor(api, 1), new AbortController().signal);
  await tick();
  await m.handleCallback(fakeCtx(1, cbData("always"), api));
  assert.equal((await p).behavior, "allow");
  assert.equal(store.isAlwaysAllowed(1, "Bash"), true);

  const { api: api2, calls: calls2 } = makeApi();
  const dec2 = await m.request(makeReq({ toolName: "Bash" }), ctxFor(api2, 1), new AbortController().signal);
  assert.equal(dec2.behavior, "allow");
  assert.equal(calls2.length, 0, "rule short-circuits the second prompt");
});

// ── timeout & abort ──〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("timeout → allow (default timeoutAction)", async () => {
  const m = new ApprovalManager();
  m.init(new Store(":memory:"));
  const { api } = makeApi();
  const p = m.request(makeReq(), ctxFor(api, 1, { timeoutMs: 30, timeoutAction: "allow" }), new AbortController().signal);
  assert.equal((await p).behavior, "allow");
});

test("timeout → deny when timeoutAction=deny", async () => {
  const m = new ApprovalManager();
  m.init(new Store(":memory:"));
  const { api } = makeApi();
  const p = m.request(makeReq(), ctxFor(api, 1, { timeoutMs: 30, timeoutAction: "deny" }), new AbortController().signal);
  const dec = await p;
  assert.equal(dec.behavior, "deny");
});

test("abort → deny", async () => {
  const m = new ApprovalManager();
  m.init(new Store(":memory:"));
  const { api } = makeApi();
  const ac = new AbortController();
  const p = m.request(makeReq(), ctxFor(api, 1, { timeoutMs: 30 }), ac.signal);
  ac.abort();
  const dec = await p;
  assert.equal(dec.behavior, "deny");
  assert.equal(dec.message, "已中止");
});

// ── idempotency & cross-chat ──〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰〰

test("idempotent: same requestId returns same promise (no double prompt)", async () => {
  const m = new ApprovalManager();
  m.init(new Store(":memory:"));
  const { api, calls } = makeApi();
  const req = makeReq();
  const ctx = ctxFor(api, 1);
  const p1 = m.request(req, ctx, new AbortController().signal);
  const p2 = m.request(req, ctx, new AbortController().signal);
  assert.equal(p1, p2);
  await tick();
  assert.equal(calls.length, 1, "prompt sent only once");
  await m.handleCallback(fakeCtx(1, cbData("allow"), api));
  assert.equal((await p1).behavior, "allow");
});

test("cross-chat tap is ignored", async () => {
  const m = new ApprovalManager();
  m.init(new Store(":memory:"));
  const { api, calls } = makeApi();
  const ac = new AbortController();
  const p = m.request(makeReq(), ctxFor(api, 1, { timeoutMs: 30 }), ac.signal);
  await tick();
  await m.handleCallback(fakeCtx(2, cbData("allow"), api)); // wrong chat
  // Still pending → abort to settle.
  ac.abort();
  assert.equal((await p).behavior, "deny");
});
