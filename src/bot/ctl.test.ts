import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBotCtl, tailBotLog, detectWatchMode } from "./ctl.js";

function fixture(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cobot-ctl-"));
  const p = join(dir, "fake.sh");
  writeFileSync(p, `#!/usr/bin/env bash\necho "FAKE $1"\n${body}\n`, { mode: 0o755 });
  return p;
}

test("runBotCtl resolves ok on exit 0 and captures output", async () => {
  const r = await runBotCtl("install", fixture("exit 0"));
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.match(r.output, /FAKE install/);
});

test("runBotCtl surfaces failure on non-zero exit", async () => {
  const r = await runBotCtl("start", fixture("echo boom; exit 3"));
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.match(r.output, /boom/);
});

test("runBotCtl resolves with failure (no throw) when the script is missing", async () => {
  // `bash` still launches; it just can't open the script and exits non-zero,
  // so we get ok:false with a code rather than a spawn error.
  const r = await runBotCtl("restart", join(tmpdir(), "does-not-exist-xyz.sh"));
  assert.equal(r.ok, false);
  assert.notEqual(r.code, 0);
});

test("tailBotLog returns last lines and falls back when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobot-log-"));
  const p = join(dir, "bot.log");
  writeFileSync(p, ["line1", "line2", "line3", "line4"].join("\n"));
  assert.equal(tailBotLog(2, p), "line3\nline4");
  assert.match(tailBotLog(12, join(dir, "missing.log")), /no log file/);
});

test("runBotCtl forces watch mode via COBOT_WATCH env", async () => {
  const r = await runBotCtl("install", fixture('echo "WATCH=$COBOT_WATCH"'), { forceWatch: true });
  assert.equal(r.ok, true);
  assert.match(r.output, /WATCH=1/);
});

test("runBotCtl forces plain mode via COBOT_WATCH=0", async () => {
  const r = await runBotCtl("install", fixture('echo "WATCH=$COBOT_WATCH"'), { forceWatch: false });
  assert.equal(r.ok, true);
  assert.match(r.output, /WATCH=0/);
});

test("runBotCtl carries notifyChatId into the child env", async () => {
  const r = await runBotCtl("install", fixture('echo "CID=$COBOT_NOTIFY_CID"'), { notifyChatId: 12345 });
  assert.equal(r.ok, true);
  assert.match(r.output, /CID=12345/);
});

test("detectWatchMode reflects process.env.COBOT_WATCH", () => {
  const prev = process.env.COBOT_WATCH;
  process.env.COBOT_WATCH = "1";
  assert.equal(detectWatchMode(), true);
  process.env.COBOT_WATCH = "0";
  assert.equal(detectWatchMode(), false);
  if (prev === undefined) delete process.env.COBOT_WATCH;
  else process.env.COBOT_WATCH = prev;
});
