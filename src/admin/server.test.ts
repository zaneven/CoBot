import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
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
  const port = 18085;
  const config = makeConfig(port);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  server.start();

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
  const port = 18086;
  const config = makeConfig(port);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  server.start();

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
  const port = 18087;
  const config = makeConfig(port);
  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  server.start();

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
