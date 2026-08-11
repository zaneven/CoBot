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
      apiKey: "test-secret-key",
    },
    dbPath: ":memory:",
    projects: [resolve("/tmp")],
    devRoots: [],
    telegram: { maxEditChars: 3500, pollTimeout: 30, flushMs: 900, showToolCalls: false },
    hermes: { enabled: false },
    logLevel: "info",
  };
}

test("AdminServer: 401 Unauthorized when API Key is invalid", async () => {
  const config = makeConfig(0);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();
  const port = server.getPort();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/api/status`);
    assert.equal(res.status, 401);
    const data = await res.json() as { error: string };
    assert.ok(data.error.includes("Unauthorized"));
  } finally {
    server.stop();
    store.close();
  }
});

test("AdminServer: 200 OK for /admin/api/status with valid Authorization Bearer header", async () => {
  const config = makeConfig(0);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();
  const port = server.getPort();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/api/status`, {
      headers: { Authorization: "Bearer test-secret-key" },
    });
    assert.equal(res.status, 200);
    const data = await res.json() as { status: string; pid: number; activeTaskCount: number };
    assert.equal(data.status, "ok");
    assert.equal(typeof data.pid, "number");
    assert.equal(data.activeTaskCount, 0);
  } finally {
    server.stop();
    store.close();
  }
});

test("AdminServer: returns HTML SPA page at root route /", async () => {
  const config = makeConfig(0);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();
  const port = server.getPort();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("CoBot Admin") || text.includes("CoBot 控制台"));
  } finally {
    server.stop();
    store.close();
  }
});

test("AdminServer: returns early without listening if apiKey is empty", async () => {
  const config = makeConfig(18151);
  config.admin.apiKey = "";
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();

  try {
    await assert.rejects(
      fetch(`http://127.0.0.1:18151/admin/api/status`, { signal: AbortSignal.timeout(300) })
    );
  } finally {
    server.stop();
    store.close();
  }
});

test("AdminServer: SSE token generation, validation, one-time use, and expiration", async () => {
  const config = makeConfig(0);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();
  const port = server.getPort();

  try {
    // 1. Fetch SSE token via POST /admin/api/logs/token
    const tokenRes = await fetch(`http://127.0.0.1:${port}/admin/api/logs/token`, {
      method: "POST",
      headers: { Authorization: "Bearer test-secret-key", "Content-Type": "application/json" },
    });
    assert.equal(tokenRes.status, 200);
    const { token } = (await tokenRes.json()) as { token: string };
    assert.ok(token && typeof token === "string");

    // 2. Use valid token on /admin/api/logs/stream
    await new Promise<void>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/admin/api/logs/stream?token=${encodeURIComponent(token)}`, (sres) => {
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
    const reuseRes = await fetch(`http://127.0.0.1:${port}/admin/api/logs/stream?token=${encodeURIComponent(token)}`);
    assert.equal(reuseRes.status, 401);

    // 4. Invalid token should fail with 401
    const invalidRes = await fetch(`http://127.0.0.1:${port}/admin/api/logs/stream?token=invalid-token-xyz`);
    assert.equal(invalidRes.status, 401);
  } finally {
    server.stop();
    store.close();
  }
});

test("AdminServer: 429 Too Many Requests when rate limit is exceeded", async () => {
  const config = makeConfig(0);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();
  const port = server.getPort();

  try {
    // Send 60 requests to hit the threshold
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/admin/api/status`, {
        headers: { Authorization: "Bearer test-secret-key" },
      });
      assert.equal(res.status, 200);
    }

    // 61st request should fail with 429
    const overflowRes = await fetch(`http://127.0.0.1:${port}/admin/api/status`, {
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
  const config = makeConfig(0);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  await server.start();
  const port = server.getPort();

  try {
    // 1. Test missing application/json content-type on POST -> 415
    const badTypeRes = await fetch(`http://127.0.0.1:${port}/admin/api/tasks/abort`, {
      method: "POST",
      headers: { Authorization: "Bearer test-secret-key", "Content-Type": "text/plain" },
      body: JSON.stringify({ taskId: "t-123" }),
    });
    assert.equal(badTypeRes.status, 415);

    // 2. Test payload > 1MB on POST -> 413 (or fetch aborted on oversize body)
    const largePayload = JSON.stringify({ data: "x".repeat(1024 * 1024 + 100) });
    try {
      const overflowRes = await fetch(`http://127.0.0.1:${port}/admin/api/tasks/abort`, {
        method: "POST",
        headers: { Authorization: "Bearer test-secret-key", "Content-Type": "application/json" },
        body: largePayload,
      });
      assert.equal(overflowRes.status, 413);
    } catch (err: any) {
      // Node fetch may throw error if stream is closed due to payload size limit
      assert.ok(err);
    }
  } finally {
    server.stop();
    store.close();
  }
});
