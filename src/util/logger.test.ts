import { test } from "node:test";
import assert from "node:assert/strict";
import { logger, setLogSink } from "./logger.js";

// The admin live-log feature pipes every formatted log line through a tee
// into an admin-registered sink (appendAdminLog). Verify the sink actually
// receives lines once registered, and is cleared on null.

test("setLogSink: receives formatted log lines, then stops after null", async () => {
  const seen: string[] = [];
  setLogSink((line) => seen.push(line));

  const marker = "sink-test-marker-" + Math.random().toString(36).slice(2, 8);
  logger.info({ src: "logger.test" }, marker);

  // pino-pretty is an async stream; poll briefly for the line to flush through.
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && !seen.some((l) => l.includes(marker))) {
    await new Promise((r) => setTimeout(r, 20));
  }

  setLogSink(null);
  logger.info({ src: "logger.test" }, "after-null-marker");
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(seen.some((l) => l.includes(marker)), `sink did not receive the line; got: ${JSON.stringify(seen)}`);
  assert.ok(!seen.some((l) => l.includes("after-null-marker")), "sink received a line after being cleared");
});

test("setLogSink: sink exceptions never break logging", async () => {
  setLogSink(() => { throw new Error("boom"); });
  // Must not throw into the caller — logging stays usable.
  assert.doesNotThrow(() => logger.info("should-not-break"));
  setLogSink(null);
});
