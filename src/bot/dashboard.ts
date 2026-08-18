import { InlineKeyboard, type Api } from "grammy";
import { fmtDuration } from "../util/duration.js";
import { logger } from "../util/logger.js";

/** Format token counts: <1k raw, ≥1k as "1.2K". */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** Clean and compact tool summary parameters for the dashboard. */
export function cleanToolSummary(name: string, summary?: string): string {
  if (!summary) return name;
  let clean = summary.trim();
  // Strip absolute file paths to basenames: /Users/a1/Develop/PicGen/index.html -> index.html
  clean = clean.replace(/(?:[/\\][\w.-]+)+[/\\]([\w.-]+)/g, "$1");
  // Strip quotes and collapse whitespace
  clean = clean.replace(/["'`]/g, "").replace(/\s+/g, " ");
  if (clean.length > 24) clean = clean.slice(0, 23) + "…";
  return clean ? `${name}: ${clean}` : name;
}

/** Format tool usage breakdown as a summary string. */
export function fmtToolBreakdown(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (!entries.length) return "";
  const total = entries.reduce((acc, [, c]) => acc + c, 0);
  const detail = entries.map(([name, c]) => (c > 1 ? `${name} ×${c}` : name)).join(", ");
  return `${total} 次 (${detail})`;
}

export interface DashboardOutcome {
  status: "done" | "aborted" | "error";
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextUsagePct?: number;
  abortedReason?: string;
  errorMessage?: string;
}

/**
 * Manages the dedicated "Task Dashboard Card" (Message 1).
 *
 * During task execution:
 * - Posts immediately on task start.
 * - Throttled in-place edits showing live elapsed time, active tool, and cumulative tool counts.
 * - Hosts an inline [⏹ 中断任务] button to stop the running task instantly.
 *
 * On task completion:
 * - Updates in-place into the final Done / Aborted / Error settlement card.
 * - Replaces the stop button with suggested next-action buttons (if available).
 */
export class TaskDashboard {
  private messageId?: number;
  private taskStartMs: number;
  private activeStatus = "正在初始化…";
  private toolCounts: Record<string, number> = {};
  private finished = false;
  private dirty = false;
  private timer?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private api: Api,
    private chatId: number,
    private flushMs = 1000,
  ) {
    this.taskStartMs = Date.now();
  }

  getMsgId(): number | undefined {
    return this.messageId;
  }

  /** Send the initial Dashboard Card with a stop button. */
  async start(): Promise<void> {
    const text = this.renderRunning();
    const kb = new InlineKeyboard().text("⏹ 中断当前任务", `stop_task:${this.chatId}`);
    try {
      const m = await this.api.sendMessage(this.chatId, text, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
      this.messageId = m.message_id;
    } catch (err) {
      logger.debug({ err: String(err) }, "TaskDashboard: start sendMessage failed");
    }
  }

  /** Update the active status line (e.g. "正在深度思考"). */
  updateAction(status: string): void {
    if (this.finished || !status) return;
    if (this.activeStatus === status) return;
    this.activeStatus = status;
    this.dirty = true;
    this.schedule();
  }

  /** Record a tool call and update active status. */
  recordTool(name: string, summary?: string): void {
    if (this.finished) return;
    this.toolCounts[name] = (this.toolCounts[name] ?? 0) + 1;
    const compact = cleanToolSummary(name, summary);
    this.activeStatus = `正在调用 ${compact}`;
    this.dirty = true;
    this.schedule();
  }

  /** Record a thinking event and update active status. */
  recordThinking(): void {
    if (this.finished) return;
    this.activeStatus = "正在深度思考…";
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.finished) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushMs);
  }

  /** In-place update the running dashboard message. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty || this.finished || !this.messageId) return;
    this.dirty = false;
    const text = this.renderRunning();
    const kb = new InlineKeyboard().text("⏹ 中断当前任务", `stop_task:${this.chatId}`);
    await this.enqueue(async () => {
      try {
        await this.api.editMessageText(this.chatId, this.messageId!, text, {
          parse_mode: "HTML",
          reply_markup: kb,
        });
      } catch (err) {
        if (!String(err).includes("not modified")) {
          logger.debug({ err: String(err) }, "TaskDashboard: flush edit failed");
        }
      }
    });
  }

  /** Render the live running dashboard text. */
  private renderRunning(): string {
    const elapsed = fmtDuration(Date.now() - this.taskStartMs);
    const lines = [
      `🤖 <b>任务进行中</b> · ⏱️ <code>${elapsed}</code>`,
      `───────────────────`,
      `⚡️ <b>当前动作</b>：${escHtml(this.activeStatus)}`,
    ];
    const tools = fmtToolBreakdown(this.toolCounts);
    if (tools) {
      lines.push(`📦 <b>工具调用</b>：${escHtml(tools)}`);
    }
    lines.push(`───────────────────`);
    return lines.join("\n");
  }

  /** Finalize the dashboard into a settlement card. */
  async finalize(outcome: DashboardOutcome, replyMarkup?: InlineKeyboard): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const text = this.renderFinished(outcome);
    await this.enqueue(async () => {
      if (this.messageId) {
        try {
          await this.api.editMessageText(this.chatId, this.messageId, text, {
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          });
          return;
        } catch (err) {
          if (!String(err).includes("not modified")) {
            logger.debug({ err: String(err) }, "TaskDashboard: finalize edit failed, falling to send");
          }
        }
      }
      // If edit failed or message was never sent, send as a fresh message
      try {
        await this.api.sendMessage(this.chatId, text, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
      } catch (err) {
        logger.debug({ err: String(err) }, "TaskDashboard: finalize send failed");
      }
    });
  }

  /** Render the completed dashboard settlement text. */
  private renderFinished(outcome: DashboardOutcome): string {
    const dur = outcome.durationMs ? fmtDuration(outcome.durationMs) : fmtDuration(Date.now() - this.taskStartMs);
    const lines: string[] = [];

    if (outcome.status === "done") {
      lines.push(`✅ <b>任务执行完成</b> · ⏱️ <code>${dur}</code>`);
      lines.push(`───────────────────`);
      const metaParts: string[] = [];
      if (outcome.costUsd !== undefined) metaParts.push(`💰 $${outcome.costUsd.toFixed(4)}`);
      if (outcome.inputTokens !== undefined && outcome.outputTokens !== undefined) {
        metaParts.push(`↑${fmtTokens(outcome.inputTokens)} ↓${fmtTokens(outcome.outputTokens)}`);
      }
      if (outcome.contextUsagePct !== undefined) {
        metaParts.push(`📊 ${outcome.contextUsagePct}%`);
      }
      if (metaParts.length) {
        lines.push(metaParts.join(" · "));
      }
      const tools = fmtToolBreakdown(this.toolCounts);
      if (tools) {
        lines.push(`📦 <b>工具调用</b>：${escHtml(tools)}`);
      }
    } else if (outcome.status === "aborted") {
      const reason = outcome.abortedReason ? ` (${outcome.abortedReason})` : "";
      lines.push(`⏹ <b>任务已中断</b>${reason} · ⏱️ <code>${dur}</code>`);
      const tools = fmtToolBreakdown(this.toolCounts);
      if (tools) {
        lines.push(`📦 <b>已调用工具</b>：${escHtml(tools)}`);
      }
    } else {
      lines.push(`⚠️ <b>任务发生错误</b> · ⏱️ <code>${dur}</code>`);
      if (outcome.errorMessage) {
        lines.push(`<code>${escHtml(outcome.errorMessage.slice(0, 300))}</code>`);
      }
    }

    return lines.join("\n");
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
