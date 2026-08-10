import type { Api } from "grammy";
import { logger } from "../util/logger.js";

/**
 * Posts a small status message when a task goes quiet, so the user isn't left
 * staring at silence during a long tool run, context compaction, or a hung
 * permission prompt (which otherwise only resolves at the watchdog timeout).
 *
 * The Claude Agent SDK only surfaces `compacting` / `requesting` status events
 * - never "waiting for permission" - so this keeps a heartbeat too: once
 * `thresholdMs` passes with no activity it shows "⏳ Still working… (Ns)" and
 * refreshes it. Any content / tool / status event calls `activity()`, which
 * deletes the indicator so it never lingers above live output.
 *
 * All sends are serialized through a promise chain to avoid overlapping edits
 * of the single indicator message.
 */
export class SilenceIndicator {
  private msgId: number | undefined;
  private lastActivity: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<void> = Promise.resolve();
  // Thinking-marker state: shown while a reasoning model thinks, cleared on
  // real activity. Throttled so a long think doesn't spam Telegram edits.
  private thinkingStart: number | undefined;
  private lastThinkingEdit = 0;
  private thinkingPending = false;

  constructor(
    private api: Api,
    private chatId: number,
    private thresholdMs = 20000,
    private intervalMs = 10000,
  ) {
    this.lastActivity = Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /** Any progress (text / tool / toolResult / status). Clears a shown indicator. */
  activity(): void {
    this.lastActivity = Date.now();
    this.thinkingStart = undefined;
    this.lastThinkingEdit = 0;
    this.thinkingPending = false;
    if (this.msgId !== undefined) this.run(() => this.clear());
  }

  /** Compaction is a known long op - show it explicitly instead of the heartbeat. */
  compacting(): void {
    this.lastActivity = Date.now();
    this.thinkingStart = undefined;
    this.run(() => this.set("🧹 Compacting context…"));
  }

  /**
   * Show a "💭 Thinking…" marker while a reasoning model thinks. Subsequent
   * calls throttle to one edit every ~3s carrying an elapsed-seconds counter,
   * so a long think shows tangible progress instead of minutes of silence.
   * Cleared by the next real {@link activity}.
   */
  thinking(): void {
    if (this.thinkingStart === undefined) this.thinkingStart = Date.now();
    this.lastActivity = Date.now();
    const now = Date.now();
    if (this.msgId !== undefined && now - this.lastThinkingEdit < 3000) return;
    // Don't stack sends before the first create resolves (deltas arrive fast).
    if (this.msgId === undefined && this.thinkingPending) return;
    this.lastThinkingEdit = now;
    if (this.msgId === undefined) this.thinkingPending = true;
    const elapsed = Math.round((now - this.thinkingStart) / 1000);
    this.run(async () => {
      this.thinkingPending = false;
      await this.set(`💭 Thinking… ${elapsed}s`);
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.thinkingStart = undefined;
    this.run(() => this.clear());
    await this.chain;
  }

  private tick(): void {
    if (Date.now() - this.lastActivity < this.thresholdMs) return;
    const elapsed = Math.round((Date.now() - this.lastActivity) / 1000);
    this.run(() => this.set(`⏳ Still working… ${elapsed}s`));
  }

  private run(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn, fn).catch(() => undefined);
  }

  private async set(text: string): Promise<void> {
    try {
      if (this.msgId === undefined) {
        const m = await this.api.sendMessage(this.chatId, text);
        this.msgId = m.message_id;
      } else {
        await this.api.editMessageText(this.chatId, this.msgId, text);
      }
    } catch (err) {
      logger.debug({ err: String(err) }, "indicator set failed");
    }
  }

  private async clear(): Promise<void> {
    if (this.msgId === undefined) return;
    const id = this.msgId;
    this.msgId = undefined;
    try {
      await this.api.deleteMessage(this.chatId, id);
    } catch {
      // already deleted / not ours to delete - ignore
    }
  }
}
