import test from "node:test";
import assert from "node:assert/strict";
import { TodoPanel } from "./todoPanel.js";
import type { TodoItem } from "../claude/types.js";

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

function todo(content: string, status: TodoItem["status"], activeForm?: string): TodoItem {
  return { content, status, ...(activeForm ? { activeForm } : {}) };
}

test("TodoPanel sends a new message on first update and renders all states", async () => {
  const api = makeStubApi();
  const panel = new TodoPanel(api, 12345, 0);
  panel.update([
    todo("同步 shared 层镜像", "in_progress", "同步 shared 层镜像"),
    todo("扩展 types", "pending"),
    todo("补测试", "pending"),
    todo("更新 skill 文档", "completed"),
  ]);
  await panel.flush();

  assert.equal(api.sent.length, 1);
  const text = api.sent[0]!.text;
  assert.ok(text.includes("同步 shared 层镜像…"), "header shows active task + ellipsis");
  assert.ok(text.includes("1/4 完成"), "completion fraction shown");
  assert.ok(text.includes("◼ <b>同步 shared 层镜像</b>"), "in-progress item uses ◼ + bold");
  assert.ok(text.includes("◻ 扩展 types"), "pending item uses ◻");
  assert.ok(text.includes("✓ <s>更新 skill 文档</s>"), "completed item uses ✓ + strikethrough");
  assert.equal(api.sent[0]!.extra?.parse_mode, "HTML");
});

test("TodoPanel edits the same message in place on subsequent updates", async () => {
  const api = makeStubApi();
  const panel = new TodoPanel(api, 12345, 0);
  panel.update([todo("task A", "in_progress"), todo("task B", "pending")]);
  await panel.flush();
  assert.equal(api.sent.length, 1);

  panel.update([todo("task A", "completed"), todo("task B", "in_progress")]);
  await panel.flush();

  assert.equal(api.sent.length, 1, "no second sendMessage");
  assert.equal(api.edited.length, 1);
  assert.equal(api.edited[0]!.msgId, 1, "edits the original message");
  assert.ok(api.edited[0]!.text.includes("1/2 完成"));
  assert.ok(api.edited[0]!.text.includes("✓ <s>task A</s>"));
  assert.ok(api.edited[0]!.text.includes("◼ <b>task B</b>"));
});

test("TodoPanel hasStarted reflects whether a plan was received", () => {
  const api = makeStubApi();
  const panel = new TodoPanel(api, 12345, 0);
  assert.equal(panel.hasStarted(), false);
  panel.update([todo("one", "pending")]);
  assert.equal(panel.hasStarted(), true);
});

test("TodoPanel finalize pins the last state and ignores later updates", async () => {
  const api = makeStubApi();
  const panel = new TodoPanel(api, 12345, 0);
  panel.update([todo("task A", "in_progress")]);
  await panel.flush();

  await panel.finalize();
  const before = api.edited.length;

  panel.update([todo("task A", "completed")]);
  await panel.flush();
  assert.equal(api.edited.length, before, "updates after finalize are dropped");
});

test("TodoPanel finalize is a no-op when no plan was ever received", async () => {
  const api = makeStubApi();
  const panel = new TodoPanel(api, 12345, 0);
  await panel.finalize();
  assert.equal(api.sent.length, 0);
  assert.equal(api.edited.length, 0);
});

test("TodoPanel heartbeat re-renders the elapsed time between todo events", async () => {
  const api = makeStubApi();
  const panel = new TodoPanel(api, 12345, 0, 10);
  panel.update([todo("task A", "in_progress")]);
  await panel.flush();
  assert.equal(api.edited.length, 0);

  // No todo events arrive; the heartbeat alone should keep editing the message
  // so the elapsed-time header keeps ticking.
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(api.edited.length >= 2, `heartbeat edits happened (got ${api.edited.length})`);

  await panel.finalize();
  const afterFinalize = api.edited.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(api.edited.length, afterFinalize, "finalize stops the heartbeat");
});

test("TodoPanel heartbeat never fires before a plan exists", async () => {
  const api = makeStubApi();
  const panel = new TodoPanel(api, 12345, 0, 5);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(api.sent.length, 0);
  assert.equal(api.edited.length, 0);
  await panel.finalize();
});
