import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { AdminServer } from "./server.js";
import { Store, type AuditLog } from "../store/db.js";
import { Registry } from "../registry/registry.js";
import { loadConfig } from "../config.js";

test("Admin API Phase 2: GET /admin/api/analytics/daily and /tools and /audit/detail", async () => {
  const config = loadConfig();
  config.admin = { enabled: true, port: 18095, apiKey: "analytics-key" };

  const store = new Store(":memory:");
  const registry = new Registry(store);
  const server = new AdminServer(config, store, registry);

  // Insert test audit records
  const sampleLog: AuditLog = {
    id: "test-audit-123",
    chatId: 1001,
    sessionId: "sess-abc",
    prompt: "Run tests and refactor code",
    tools: JSON.stringify(["Read", "Bash", "Write"]),
    status: "done",
    costUsd: 0.1234,
    durationMs: 4500,
    inputTokens: 1000,
    outputTokens: 500,
    contextUsagePct: 25,
    startedAt: Date.now(),
    endedAt: Date.now() + 4500,
  };
  store.insertAudit(sampleLog);

  server.start();

  try {
    // 1. GET /admin/api/analytics/daily
    const dailyRes = await fetch("http://127.0.0.1:18095/admin/api/analytics/daily?days=7", {
      headers: { Authorization: "Bearer analytics-key" },
    });
    assert.equal(dailyRes.status, 200);
    const dailyData = await dailyRes.json() as { daily: Array<{ totalTasks: number }> };
    assert.ok(Array.isArray(dailyData.daily));
    assert.ok(dailyData.daily.length >= 1);
    assert.equal(dailyData.daily[0]!.totalTasks, 1);

    // 2. GET /admin/api/analytics/tools
    const toolsRes = await fetch("http://127.0.0.1:18095/admin/api/analytics/tools", {
      headers: { Authorization: "Bearer analytics-key" },
    });
    assert.equal(toolsRes.status, 200);
    const toolsData = await toolsRes.json() as { tools: Array<{ tool: string; count: number }> };
    assert.ok(Array.isArray(toolsData.tools));
    assert.ok(toolsData.tools.some((t) => t.tool === "Bash" && t.count === 1));

    // 3. GET /admin/api/audit/detail
    const detailRes = await fetch("http://127.0.0.1:18095/admin/api/audit/detail?id=test-audit-123", {
      headers: { Authorization: "Bearer analytics-key" },
    });
    assert.equal(detailRes.status, 200);
    const detailData = await detailRes.json() as { audit: AuditLog };
    assert.equal(detailData.audit.id, "test-audit-123");
    assert.equal(detailData.audit.prompt, "Run tests and refactor code");
  } finally {
    server.stop();
    store.close();
  }
});
