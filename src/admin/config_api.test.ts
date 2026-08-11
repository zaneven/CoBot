import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { AdminServer } from "./server.js";
import { Store } from "../store/db.js";
import { Registry } from "../registry/registry.js";
import { loadConfig } from "../config.js";

const tmpConfigPath = resolve(process.cwd(), "config.tmp.test.yaml");

function cleanup() {
  if (existsSync(tmpConfigPath)) {
    try { unlinkSync(tmpConfigPath); } catch {}
  }
}

test("Admin API Phase 1: GET & POST /admin/api/config update and hot-reload", async () => {
  cleanup();
  writeFileSync(tmpConfigPath, "defaults:\n  maxTurns: 30\n", "utf8");

  const config = loadConfig(tmpConfigPath);
  config.admin = { enabled: true, host: "127.0.0.1", port: 18090, apiKey: "test-key" };

  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry, undefined, tmpConfigPath);

  server.start();

  try {
    // 1. GET /admin/api/config
    const getRes = await fetch("http://127.0.0.1:18090/admin/api/config", {
      headers: { Authorization: "Bearer test-key" },
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json() as { rawYaml: string };
    assert.ok(getData.rawYaml.includes("maxTurns: 30"));

    // 2. POST /admin/api/config (save and hot-reload)
    const postRes = await fetch("http://127.0.0.1:18090/admin/api/config", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ defaults: { maxTurns: 88 } }),
    });
    assert.equal(postRes.status, 200);
    const postData = await postRes.json() as { success: boolean; config: { claude: { maxTurns: number } } };
    assert.equal(postData.success, true);
  } finally {
    server.stop();
    store.close();
    cleanup();
  }
});

test("Admin API Phase 1: POST & DELETE /admin/api/bindings for Chat binding management", async () => {
  const config = loadConfig();
  config.admin = { enabled: true, host: "127.0.0.1", port: 18091, apiKey: "test-key" };

  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  server.start();

  try {
    // 1. Upsert binding via Admin API
    const postRes = await fetch("http://127.0.0.1:18091/admin/api/bindings", {
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: 999888, projectPath: "/tmp/my-project" }),
    });
    assert.equal(postRes.status, 200);

    const binding = store.getBinding(999888);
    assert.ok(binding);
    assert.equal(binding.projectPath, "/tmp/my-project");

    // 2. Delete binding via Admin API
    const delRes = await fetch("http://127.0.0.1:18091/admin/api/bindings", {
      method: "DELETE",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: 999888 }),
    });
    assert.equal(delRes.status, 200);

    const cleared = store.getBinding(999888);
    assert.equal(cleared, undefined);
  } finally {
    server.stop();
    store.close();
  }
});
