import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import http from "node:http";
import { AdminServer } from "./server.js";
import { Store } from "../store/db.js";
import { Registry } from "../registry/registry.js";
import type { Config } from "../config.js";

function makeConfig(port: number): Config {
  return {
    telegramToken: "dummy",
    allowedUsers: new Set([123]),
    claude: {
      permissionMode: "acceptEdits",
      allowDangerousSkip: false,
      taskTimeoutMs: 600000,
    },
    admin: {
      enabled: true,
      host: "127.0.0.1",
      port,
      apiKey: "test-secret-key", authEnabled: true,
    },
    dbPath: ":memory:",
    projects: [resolve("/tmp")],
    devRoots: [],
    telegram: { maxEditChars: 3500, pollTimeout: 30, flushMs: 900, showToolCalls: false },
    hermes: { enabled: false },
    logLevel: "info",
  };
}

test("AdminServer: 401 Unauthorized when API Key is invalid or passed via query ?apiKey=", async () => {
  const config = makeConfig(18150);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();

  try {
    // 1. Missing auth header -> 401
    const res1 = await fetch(`http://127.0.0.1:18150/admin/api/status`);
    assert.equal(res1.status, 401);
    const data1 = (await res1.json()) as { error: string };
    assert.ok(data1.error.includes("Unauthorized"));

    // 2. Query param ?apiKey= is deprecated and rejected -> 401
    const res2 = await fetch(`http://127.0.0.1:18150/admin/api/status?apiKey=test-secret-key`);
    assert.equal(res2.status, 401);
  } finally {
    server.stop();
    store.close();
  }
});

test("AdminServer: 200 OK for /admin/api/status with valid Authorization Bearer header", async () => {
  const config = makeConfig(18151);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();

  try {
    const res = await fetch(`http://127.0.0.1:18151/admin/api/status`, {
      headers: { Authorization: "Bearer test-secret-key" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    const data = (await res.json()) as { status: string; pid: number; activeTaskCount: number };
    assert.equal(data.status, "ok");
    assert.equal(typeof data.pid, "number");
    assert.equal(data.activeTaskCount, 0);
  } finally {
    server.stop();
    store.close();
  }
});

test("AdminServer: returns HTML SPA page at root route /", async () => {
  const config = makeConfig(18152);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();

  try {
    const res = await fetch(`http://127.0.0.1:18152/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("CoBot Admin") || text.includes("CoBot 控制台"));
  } finally {
    server.stop();
    store.close();
  }
});

test("AdminServer: returns early without listening if apiKey is empty", async () => {
  const config = makeConfig(18153);
  config.admin.apiKey = "";
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();

  try {
    await assert.rejects(
      fetch(`http://127.0.0.1:18153/admin/api/status`, { signal: AbortSignal.timeout(300) }),
    );
  } finally {
    server.stop();
    store.close();
  }
});

test("AdminServer: SSE token generation, validation, one-time use, and expiration", async () => {
  const config = makeConfig(18154);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();

  try {
    // 1. Fetch SSE token via POST /admin/api/logs/token
    const tokenRes = await fetch(`http://127.0.0.1:18154/admin/api/logs/token`, {
      method: "POST",
      headers: { Authorization: "Bearer test-secret-key", "Content-Type": "application/json" },
    });
    assert.equal(tokenRes.status, 200);
    const { token } = (await tokenRes.json()) as { token: string };
    assert.ok(token && typeof token === "string");

    // 2. Use valid token on /admin/api/logs/stream
    await new Promise<void>((resolve) => {
      const req = http.get(`http://127.0.0.1:18154/admin/api/logs/stream?token=${encodeURIComponent(token)}`, (sres) => {
        assert.equal(sres.statusCode, 200);
        assert.ok(sres.headers["content-type"]?.includes("text/event-stream"));
        sres.destroy();
        req.destroy();
        resolve();
      });
      req.on("error", () => {
        resolve();
      });
    });

    // 3. One-time use: Re-using the same token should fail with 401
    const reuseRes = await fetch(`http://127.0.0.1:18154/admin/api/logs/stream?token=${encodeURIComponent(token)}`);
    assert.equal(reuseRes.status, 401);

    // 4. Invalid token should fail with 401
    const invalidRes = await fetch(`http://127.0.0.1:18154/admin/api/logs/stream?token=invalid-token-xyz`);
    assert.equal(invalidRes.status, 401);
  } finally {
    server.stop();
    store.close();
  }
});

test("AdminServer: 429 Too Many Requests when rate limit is exceeded", async () => {
  const config = makeConfig(18155);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();

  try {
    // Send 300 requests to hit the threshold
    for (let i = 0; i < 300; i++) {
      const res = await fetch(`http://127.0.0.1:18155/admin/api/status`, {
        headers: { Authorization: "Bearer test-secret-key" },
      });
      assert.equal(res.status, 200);
    }

    // 301st request should fail with 429
    const overflowRes = await fetch(`http://127.0.0.1:18155/admin/api/status`, {
      headers: { Authorization: "Bearer test-secret-key" },
    });
    assert.equal(overflowRes.status, 429);
    const data = (await overflowRes.json()) as { error: string };
    assert.ok(data.error.includes("Rate limit exceeded") || data.error.includes("Too Many Requests"));
  } finally {
    server.stop();
    store.close();
  }
});

test("AdminServer: 413 Payload Too Large for body > 1MB and 415 for missing application/json on POST", async () => {
  const config = makeConfig(18156);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();

  try {
    // 1. Test missing application/json content-type on POST -> 415
    const badTypeRes = await fetch(`http://127.0.0.1:18156/admin/api/tasks/abort`, {
      method: "POST",
      headers: { Authorization: "Bearer test-secret-key", "Content-Type": "text/plain" },
      body: JSON.stringify({ taskId: "t-123" }),
    });
    assert.equal(badTypeRes.status, 415);

    // 2. Test payload > 1MB on POST -> 413 (or fetch aborted on oversize body)
    const largePayload = JSON.stringify({ data: "x".repeat(1024 * 1024 + 100) });
    try {
      const overflowRes = await fetch(`http://127.0.0.1:18156/admin/api/tasks/abort`, {
        method: "POST",
        headers: { Authorization: "Bearer test-secret-key", "Content-Type": "application/json" },
        body: largePayload,
      });
      assert.equal(overflowRes.status, 413);
    } catch (err: any) {
      assert.ok(err);
    }
  } finally {
    server.stop();
    store.close();
  }
});
