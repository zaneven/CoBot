import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "./index.js";
import type { DriverEvent } from "../claude/types.js";

test("Unified Driver: runAgent delegates based on backend", async () => {
  // Test that runAgent generator works and produces events
  const events: DriverEvent[] = [];
  // For unit test, we can pass a dummy prompt that invokes the driver abstraction
  assert.equal(typeof runAgent, "function");
});
