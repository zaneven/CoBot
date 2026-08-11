import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminServer } from "./server.js";
import { Store } from "../store/db.js";
import { Registry } from "../registry/registry.js";
import { loadConfig } from "../config.js";
import { getLogLevel, setLogLevel } from "../util/logger.js";

test("Admin API: GET & POST /admin/api/log-level for dynamic Pino log level control", async () => {
  const config = loadConfig();
  config.admin = { enabled: true, host: "127.0.0.1", port: 18099, apiKey: "loglevel-key" };

  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  server.start();

  try {
    // 1. GET /admin/api/log-level
    const getRes = await fetch("http://127.0.0.1:18099/admin/api/log-level", {
      headers: { Authorization: "Bearer loglevel-key" },
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json() as { level: string };
    assert.ok(typeof getData.level === "string");

    // 2. POST /admin/api/log-level (valid level)
    const postRes = await fetch("http://127.0.0.1:18099/admin/api/log-level", {
      method: "POST",
      headers: { Authorization: "Bearer loglevel-key", "Content-Type": "application/json" },
      body: JSON.stringify({ level: "debug" }),
    });
    assert.equal(postRes.status, 200);
    const postData = await postRes.json() as { success: boolean; level: string };
    assert.equal(postData.success, true);
    assert.equal(postData.level, "debug");

    // 3. POST /admin/api/log-level (invalid level -> 400)
    const badRes = await fetch("http://127.0.0.1:18099/admin/api/log-level", {
      method: "POST",
      headers: { Authorization: "Bearer loglevel-key", "Content-Type": "application/json" },
      body: JSON.stringify({ level: "invalid_level_xxx" }),
    });
    assert.equal(badRes.status, 400);
  } finally {
    server.stop();
    store.close();
  }
});
