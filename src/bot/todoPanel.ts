import type { Api } from "grammy";
import type { TodoItem } from "../claude/types.js";
import { fmtDuration } from "../util/duration.js";
import { logger } from "../util/logger.js";

/** Format a duration in Claude-Code's compact style (e.g. "5m 13s"). */
function fmtClaudeDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m <= 0) return `${rs}s`;
  return rs ? `${m}m ${rs}s` : `${m}m`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Dedicated "任务清单" message: replicates Claude Code's live task-tracker
 * panel. The first {@link TodoWrite} update sends a new message; each
 * subsequent update edits it in place so the user watches tasks flip from
 * ◻ (pending) to ◼ (in progress) to ✓ (completed) as the run proceeds.
 *
 * The header mirrors Claude Code's "当前任务… (5m 13s · 1/4 完成)" line; token
 * deltas aren't available mid-stream from the SDK, so the completion fraction
 * stands in for progress.
 */
export class TodoPanel {
  private messageId?: number;
  private todos: TodoItem[] = [];
  private startedAt = Date.now();
  private finished = false;
  private dirty = false;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private api: Api,
    private chatId: number,
    private flushMs = 900,
    /** Re-render cadence for the elapsed-time ticker, independent of todo events. */
    private heartbeatMs = 10_000,
  ) {}

  /** Whether any todo plan has been received yet. */
  hasStarted(): boolean {
    return this.todos.length > 0;
  }

  /** Replace the plan with a fresh snapshot from the model's TodoWrite call. */
  update(todos: TodoItem[]): void {
    if (this.finished) return;
    this.todos = todos;
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.finished) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushMs);
    // UI refresh nicety only — must never hold the process open (the bot's
    // lifecycle is owned by the gateway connection; finalize() always runs
    // before the turn ends).
    this.timer.unref?.();
  }

  async flush(force = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty && !force) {
      this.armHeartbeat(); // keep the ticker alive even on no-op flushes
      return;
    }
    this.dirty = false;
    const text = this.render();
    await this.enqueue(async () => {
      try {
        if (this.messageId === undefined) {
          const m = await this.api.sendMessage(this.chatId, text, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
          this.messageId = m.message_id;
        } else {
          await this.api.editMessageText(this.chatId, this.messageId, text, {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          });
        }
      } catch (err) {
        if (!String(err).includes("not modified")) {
          logger.debug({ err: String(err) }, "TodoPanel: flush failed");
        }
      }
    });
    this.armHeartbeat();
  }

  /**
   * Keep the elapsed-time header ticking between todo events: re-render on a
   * slow cadence even when nothing changed. Without this the panel freezes at
   * the timestamp of its last update and looks stuck even while the run
   * progresses. Stopped by {@link finalize}.
   */
  private armHeartbeat(): void {
    if (this.heartbeat || this.finished || this.todos.length === 0) return;
    this.heartbeat = setTimeout(() => {
      this.heartbeat = undefined;
      void this.flush(true);
    }, this.heartbeatMs);
    // Same as schedule(): never hold the process open for a re-render.
    this.heartbeat.unref?.();
  }

  /** Stop tracking and pin the final state of the panel. */
  async finalize(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    for (const t of [this.timer, this.heartbeat]) {
      if (t) clearTimeout(t);
    }
    this.timer = undefined;
    this.heartbeat = undefined;
    if (this.messageId === undefined) return; // never surfaced — nothing to pin
    this.dirty = true;
    await this.flush();
  }

  /** Render the panel as HTML: header + checkbox list + footer. */
  render(): string {
    const total = this.todos.length;
    const done = this.todos.filter((t) => t.status === "completed").length;
    const active = this.todos.find((t) => t.status === "in_progress");
    const elapsed = fmtClaudeDuration(Date.now() - this.startedAt);

    const lines: string[] = [];
    const heading = active
      ? `${escHtml(active.activeForm || active.content)}…`
      : "任务清单";
    lines.push(`📋 <b>${heading}</b> (${elapsed} · ${done}/${total} 完成)`);
    lines.push("───────────────────");
    for (const t of this.todos) {
      if (t.status === "completed") {
        lines.push(`✓ <s>${escHtml(t.content)}</s>`);
      } else if (t.status === "in_progress") {
        lines.push(`◼ <b>${escHtml(t.content)}</b>`);
      } else {
        lines.push(`◻ ${escHtml(t.content)}`);
      }
    }
    lines.push("───────────────────");
    return lines.join("\n");
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }
}
