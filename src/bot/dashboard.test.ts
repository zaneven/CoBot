import test from "node:test";
import assert from "node:assert/strict";
import { TaskDashboard, cleanToolSummary, fmtToolBreakdown } from "./dashboard.js";

function makeStubApi() {
  const sent: Array<{ text: string; extra?: any }> = [];
  const edited: Array<{ msgId: number; text: string; extra?: any }> = [];

  const api: any = {
    sent,
    edited,
    sendMessage(chatId: number, text: string, extra?: any) {
      sent.push({ text, extra });
      return Promise.resolve({ message_id: sent.length });
    },
    editMessageText(chatId: number, msgId: number, text: string, extra?: any) {
      edited.push({ msgId, text, extra });
      return Promise.resolve(true);
    },
  };
  return api;
}

test("cleanToolSummary extracts basenames and limits length", () => {
  assert.equal(cleanToolSummary("Read", "/Users/a1/Develop/PicGen/index.html"), "Read: index.html");
  assert.equal(cleanToolSummary("Bash", "python -m py_compile server.py"), "Bash: python -m py_compile se…");
  assert.equal(cleanToolSummary("TaskCreate"), "TaskCreate");
});

test("fmtToolBreakdown summarizes tool counts with multipliers", () => {
  assert.equal(fmtToolBreakdown({}), "");
  assert.equal(fmtToolBreakdown({ Read: 1 }), "1 次 (Read)");
  assert.equal(fmtToolBreakdown({ Read: 2, Bash: 1 }), "3 次 (Read ×2, Bash)");
});

test("TaskDashboard starts with running status and stop button", async () => {
  const api = makeStubApi();
  const dashboard = new TaskDashboard(api, 12345, 0);
  await dashboard.start();

  assert.equal(api.sent.length, 1);
  assert.ok(api.sent[0].text.includes("任务进行中"));
  assert.ok(api.sent[0].text.includes("正在初始化"));
  // Stop button inline keyboard
  assert.ok(api.sent[0].extra?.reply_markup);
});

test("TaskDashboard updates tool and flushes edits", async () => {
  const api = makeStubApi();
  const dashboard = new TaskDashboard(api, 12345, 0);
  await dashboard.start();

  dashboard.recordTool("Read", "/Users/a1/src/bot.ts");
  await dashboard.flush();

  assert.equal(api.edited.length, 1);
  assert.ok(api.edited[0].text.includes("正在调用 Read: bot.ts"));
  assert.ok(api.edited[0].text.includes("1 次 (Read)"));
});

test("TaskDashboard finalizes into completed settlement card", async () => {
  const api = makeStubApi();
  const dashboard = new TaskDashboard(api, 12345, 0);
  await dashboard.start();

  dashboard.recordTool("Write", "stats.html");
  await dashboard.finalize({
    status: "done",
    durationMs: 45000,
    costUsd: 0.0123,
    inputTokens: 1400,
    outputTokens: 650,
    contextUsagePct: 18,
  });

  assert.equal(api.edited.length, 1);
  const text = api.edited[0].text;
  assert.ok(text.includes("任务执行完成"));
  assert.ok(text.includes("45秒"));
  assert.ok(text.includes("$0.0123"));
  assert.ok(text.includes("↑1.4K ↓650"));
  assert.ok(text.includes("18%"));
  assert.ok(text.includes("1 次 (Write)"));
});

test("TaskDashboard finalizes into aborted settlement card", async () => {
  const api = makeStubApi();
  const dashboard = new TaskDashboard(api, 12345, 0);
  await dashboard.start();

  await dashboard.finalize({
    status: "aborted",
    durationMs: 12000,
    abortedReason: "用户中断",
  });

  assert.equal(api.edited.length, 1);
  const text = api.edited[0].text;
  assert.ok(text.includes("任务已中断"));
  assert.ok(text.includes("用户中断"));
});
