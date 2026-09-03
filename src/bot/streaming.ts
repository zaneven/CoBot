import type { Api } from "grammy";
import { logger } from "../util/logger.js";
import { mdToTelegramHtml, sanitizeStreamMarkdown, escapeMd } from "../util/tgfmt.js";
import { fmtDuration } from "../util/duration.js";

/** Telegram Rich Message hard limit is 32768 UTF-8 chars. We split at 32000. */
const TG_HARD_LIMIT = 32000;

/**
 * One physical Telegram message in the chain, plus the last text we sent to it
 * so the next flush can diff and skip unchanged messages (only the live, still-
 * growing message is re-edited each tick).
 */
interface PhysMsg {
  id?: number;
  text: string;
}

/**
 * Streams assistant text into a Telegram chat by progressively editing a chain
 * of Rich Messages (`sendRichMessage` → `editMessageText` with `rich_message`),
 * spilling into a new message only when a message reaches Telegram's 32k hard
 * limit. Falls back to HTML parse mode if Rich isn't available.
 *
 * The full answer text is kept as the single source of truth (`content`) and is
 * NEVER cleared — each flush re-renders the whole logical message, paginates it
 * at the 32k limit, and reconciles the physical chain against the previous
 * render (send new chunks, edit the changed ones, leave the rest). Because the
 * content is never lost, a long answer that overflows into 2+ messages splits
 * cleanly at a line boundary instead of being glued/duplicated, and the `done`
 * reconciliation (`ensureContains`) becomes a no-op in the normal case rather
 * than re-appending the whole answer onto a cleared buffer.
 *
 * All sends are serialized through a promise chain to avoid overlapping edits /
 * rate limits. Once a transport mode settles it stays put — no flip-flopping.
 */
export class TelegramStreamer {
  /** Optional top-of-message meta line (e.g. "⏱️ 思考 … · 🔧 调用 N 工具"). */
  private header = "";
  /** Reasoning ("thinking") bookkeeping. */
  private thinkingActive = false;
  private thinkingStartMs = 0;
  private thinkingTotalMs = 0;
  private hadThinking = false;
  /** Sequential tool execution steps for the expandable process section. */
  private toolSteps: Array<{ name: string; summary: string; isError?: boolean }> = [];
  /** The complete assistant answer text accumulated across all agentic turns — the
   *  single source of truth. Never polluted with tool logs. */
  private content = "";
  private msgs: PhysMsg[] = [];
  private dirty = false;
  private finished = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  /** null = first flush not yet done; true = Rich; false = HTML fallback. */
  private richMode: boolean | null = null;

  constructor(
    private api: Api,
    private chatId: number,
    /** Accepted for API compatibility; chunking is now at Telegram's hard
     *  limit, not this value — the old per-`maxEditChars` auto-flush reset the
     *  buffer and caused content duplication. */
    _maxEditChars: number = TG_HARD_LIMIT,
    private flushMs = 900,
  ) {}

  /** Append assistant text. */
  text(delta: string): Promise<void> {
    if (this.finished || !delta) return Promise.resolve();
    this.closeThinking();
    this.content += delta;
    this.dirty = true;
    this.schedule();
    return Promise.resolve();
  }

  /**
   * Replace the whole streamed body (the header is kept). Unlike {@link text},
   * which appends token deltas, this re-renders the entire logical message from
   * a fully-composed string each call — for callers that build the content
   * themselves each tick (e.g. a growing bullet list of completed trace blocks)
   * instead of feeding raw deltas. Marks dirty and schedules a throttled flush,
   * so rapid successive calls coalesce into one edit. No-op after finalize()
   * and on empty input (so a caller can drive it unconditionally each tick and
   * only the non-empty renders send).
   */
  setContent(text: string): Promise<void> {
    if (this.finished || !text) return Promise.resolve();
    this.closeThinking();
    this.content = text;
    this.dirty = true;
    this.schedule();
    return Promise.resolve();
  }

  /**
   * Reset / discard any preamble text and delete premature messages if any were sent.
   */
  async reset(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.dirty = false;
    this.content = "";
    while (this.msgs.length > 0) {
      const m = this.msgs.pop()!;
      if (m.id !== undefined) {
        try {
          await (this.api as any).deleteMessage(this.chatId, m.id);
        } catch {
          /* best effort */
        }
      }
    }
  }

  /**
   * Start the next agentic turn's text on a fresh line. Called at each
   * `roundStart` so per-turn narration beats stack one-per-line (like the
   * Claude Code client) instead of gluing into one wall of text. No-op on an
   * empty buffer (the first turn) or when the buffer already ends on a line
   * break, so it never introduces blank stacking.
   */
  newline(): void {
    if (this.finished) return;
    if (this.content && !this.content.endsWith("\n")) {
      this.content += "\n";
      this.dirty = true;
      this.schedule();
    }
  }

  /** Record a tool call step in the expandable process section. */
  toolLine(name: string, summary: string): Promise<void> {
    if (this.finished) return Promise.resolve();
    this.closeThinking();
    this.toolSteps.push({ name, summary, isError: false });
    this.dirty = true;
    this.schedule();
    return Promise.resolve();
  }

  /** Record / update a tool execution result in the expandable process section. */
  toolResult(name: string, content: string, isError: boolean): Promise<void> {
    if (this.finished) return Promise.resolve();
    this.closeThinking();
    const last = [...this.toolSteps].reverse().find((s) => s.name === name);
    if (last) {
      last.isError = isError;
    } else {
      this.toolSteps.push({ name, summary: truncateOneline(content, 200), isError });
    }
    this.dirty = true;
    this.schedule();
    return Promise.resolve();
  }

  /**
   * Record a reasoning ("thinking") fragment.
   */
  thinking(delta: string): Promise<void> {
    if (this.finished || !delta) return Promise.resolve();
    if (!this.thinkingActive) {
      this.thinkingActive = true;
      this.thinkingStartMs = Date.now();
      this.hadThinking = true;
    }
    this.dirty = true;
    this.schedule();
    return Promise.resolve();
  }

  /**
   * Close the in-progress thinking span, banking its wall-clock slice into the
   * running total.
   */
  private closeThinking(): void {
    if (!this.thinkingActive) return;
    this.thinkingTotalMs += Date.now() - this.thinkingStartMs;
    this.thinkingActive = false;
    this.dirty = true;
    this.schedule();
  }

  /**
   * Set/replace the top-of-message meta line. Rendered above the streamed body
   * on the next flush, so callers can update it live (e.g. as tool calls land).
   * No-op when unchanged or after finalize.
   */
  setHeader(h: string): void {
    this.closeThinking();
    if (this.finished || h === this.header) return;
    this.header = h;
    this.dirty = true;
    this.schedule();
  }

  /**
   * Append a Claude-Code-style run summary block to the end of the streamed
   * message (never sent separately, so it stays attached to the answer).
   * Call once, just before finalize(), on success. The caller formats the
   * content — this just routes it through the same transport as text().
   */
  summary(markdown: string): Promise<void> {
    if (this.finished || !markdown) return Promise.resolve();
    this.closeThinking();
    this.content += `\n\n${markdown.replace(/\n{2,}/g, "\n")}`;
    this.dirty = true;
    this.schedule();
    return Promise.resolve();
  }

  private schedule(): void {
    if (this.timer || this.finished) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushMs);
  }

  /**
   * Re-render the full logical message and reconcile the physical Telegram
   * chain against it: paginate at the 32k limit, send any new chunks, edit any
   * chunks whose text changed (only the live, still-growing one, normally), and
   * leave unchanged frozen chunks alone. Serialized through {@link enqueue} so
   * overlapping flushes never step on each other.
   */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return Promise.resolve();
    this.dirty = false;
    const full = this.render();
    if (!full.trim()) return Promise.resolve();
    return this.enqueue(() => this.syncMessages(full));
  }

  /** Compose the full logical message: header, body. */
  private render(): string {
    const body = this.content.replace(/\n{3,}/g, "\n\n").trim();
    return this.header ? `${this.header}\n\n${body}` : body;
  }

  private finalReplyMarkup: any = undefined;

  /**
   * Reconcile the physical message chain against `full`: paginate, grow/trim
   * the {@link msgs} slots, then for each chunk send (new slot) or edit
   * (changed text), skipping unchanged slots so only the live message is
   * touched on a normal tick.
   */
  private async syncMessages(full: string): Promise<void> {
    const chunks = chunkText(full, TG_HARD_LIMIT);
    while (this.msgs.length < chunks.length) this.msgs.push({ text: "" });
    // The render shrank below a chunk boundary (rare: a header rewrite that's
    // shorter). Drop the orphaned message rather than leave stale text up.
    while (this.msgs.length > chunks.length) {
      const orphan = this.msgs.pop()!;
      if (orphan.id !== undefined) {
        try {
          await (this.api as any).deleteMessage(this.chatId, orphan.id);
        } catch {
          /* best effort */
        }
      }
    }
    for (let i = 0; i < chunks.length; i++) {
      const want = chunks[i]!;
      const m = this.msgs[i]!;
      const isLast = i === chunks.length - 1;
      const markup = isLast && this.finished ? this.finalReplyMarkup : undefined;
      if (m.id === undefined) {
        const id = await this.sendStreamMessage(want, undefined, markup);
        m.id = id;
        m.text = want;
      } else if (m.text !== want || markup) {
        // A failed rich edit is retried as a fresh sendRichMessage (see
        // sendStreamMessage), which returns a NEW message id — record it so
        // later edits target the replacement, not the deleted original.
        const id = await this.sendStreamMessage(want, m.id, markup);
        if (id !== undefined && id !== m.id) m.id = id;
        m.text = want;
      }
      // else: unchanged frozen chunk — skip the edit entirely.
    }
  }

  async finalize(replyMarkup?: any): Promise<void> {
    if (this.finished) return; // guard against a second finalize (e.g. finally safety-net)
    this.closeThinking();
    this.finished = true;
    this.finalReplyMarkup = replyMarkup;
    await this.flush();
    // Rich Messages silently drop reply_markup (buttons never render on a rich
    // message — same gotcha sendRichText works around), so re-attach the keyboard
    // via the standard editMessageReplyMarkup after the final flush, falling back
    // to a separate plain message carrying the buttons when even that fails.
    // No-op in HTML/plain mode (those transports already attach reply_markup)
    // and when no keyboard was requested.
    await this.attachMarkupFallback(replyMarkup);
  }

  private async attachMarkupFallback(replyMarkup?: any): Promise<void> {
    if (!replyMarkup || !this.richMode) return;
    const last = this.msgs[this.msgs.length - 1];
    if (!last || last.id === undefined) return;
    try {
      await (this.api as any).editMessageReplyMarkup(this.chatId, last.id, undefined, { reply_markup: replyMarkup });
    } catch (err) {
      if (isBenign(err)) return; // "not modified" — markup already attached, done
      logger.debug({ err: String(err) }, "streamer: could not attach markup to rich message");
      try {
        await this.api.sendMessage(this.chatId, "💡 建议的下一步操作：", { reply_markup: replyMarkup });
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Make sure the streamed body already contains the complete final answer.
   * The SDK's incremental text deltas (includePartialMessages) don't always
   * cover the very last turn, so the authoritative full text is only in the
   * `done` event's `result`. When the live body is missing part of it, splice
   * in whatever is missing using a longest-common-suffix merge — this avoids
   * duplicating text that did stream correctly and tolerates the body already
   * containing the whole answer (in which case this is a no-op).
   *
   * Because {@link content} is never cleared, the normal case (the driver
   * already streamed the whole answer) is a no-op — this only ever appends a
   * genuinely-missing tail, never the whole answer. It exists purely as a
   * safety net for the edge case where partial deltas skipped a span.
   *
   * `text` should be the display-ready answer (e.g. next-actions block already
   * stripped), since the live body already had that block filtered out.
   */
  ensureContains(text: string): void {
    if (this.finished || !text) return;
    this.closeThinking();
    const body = this.content;
    if (body.includes(text)) return; // already complete — nothing to add
    // Find the longest suffix of body that is also a prefix of text, so we only
    // append the genuinely-missing tail instead of re-pasting the overlap.
    let overlap = 0;
    const maxK = Math.min(body.length, text.length);
    for (let k = 1; k <= maxK; k++) {
      if (body.slice(body.length - k) === text.slice(0, k)) overlap = k;
    }
    const missing = text.slice(overlap);
    if (!missing) return;
    this.content += missing;
    this.dirty = true;
    this.schedule();
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  // ── send-state machine ────────────────────────────────────────────────

  /**
   * Send (new slot) or edit (existing id) one chunk of streamed markdown. The
   * first ever call probes Rich Messages and settles {@link richMode}; after
   * that the settled transport is used. Returns the message id for new sends
   * (so the caller can record it on the slot), or the same id for edits.
   *
   * `replyMarkup` is deliberately NOT forwarded into the rich payload: Telegram
   * rejects `reply_markup` nested inside a `rich_message` object (and silently
   * ignores it when passed alongside), so buttons are attached separately by
   * {@link finalize}'s `editMessageReplyMarkup` step. Only the HTML fallback
   * (which uses the standard `text`/`parse_mode` fields) carries the keyboard
   * inline.
   *
   * Transports are tried in priority order. A failed rich EDIT is retried as a
   * fresh `sendRichMessage` (deleting the stale message first) before
   * degrading to HTML — this keeps {@link richMode} true so later chunks still
   * render as rich, and never drops content the way HTML would (HTML is capped
   * at Telegram's 4096-char text limit and can't carry a > 4k chunk).
   */
  private async sendStreamMessage(
    markdown: string,
    msgId?: number,
    replyMarkup?: any,
  ): Promise<number | undefined> {
    const apiAny = this.api as any;
    const edit = msgId !== undefined;
    const safe = sanitizeStreamMarkdown(markdown);

    // ── first flush: probe Rich Messages ──────────────────────────────
    if (this.richMode === null) {
      try {
        const m = await apiAny.sendRichMessage(this.chatId, { markdown: safe });
        this.richMode = true;
        return m.message_id;
      } catch (err) {
        if (isBenign(err)) return msgId;
        logger.debug({ err: String(err) }, "sendRichMessage failed; using HTML");
        this.richMode = false;
        // Fall through to HTML below.
      }
    }

    // ── Rich mode — edit in place (or send new for a new slot) ────────
    if (this.richMode) {
      try {
        if (edit) {
          await apiAny.editMessageText(this.chatId, msgId, { markdown: safe });
          return msgId;
        }
        const m = await apiAny.sendRichMessage(this.chatId, { markdown: safe });
        return m.message_id;
      } catch (err) {
        if (isBenign(err)) return msgId;
        logger.debug(
          { err: String(err) },
          "rich edit/send failed; retrying as new rich message",
        );
        // An edit can fail (message too old, or the server rejecting the rich
        // payload). Rather than permanently degrading the whole stream to HTML
        // — which can't carry a chunk > Telegram's 4096-char text limit and
        // would DROP the content — retry as a fresh sendRichMessage (the
        // reliable path, supports up to 32k). Delete the stale message first so
        // the user doesn't see a duplicate. Keep richMode true so subsequent
        // chunks still render as rich.
        if (edit) {
          try {
            await apiAny.deleteMessage(this.chatId, msgId!);
          } catch {
            /* best effort — the message may already be gone */
          }
          try {
            const m = await apiAny.sendRichMessage(this.chatId, { markdown: safe });
            return m.message_id; // new id — syncMessages updates the slot
          } catch (err2) {
            if (isBenign(err2)) return undefined;
            logger.debug(
              { err: String(err2) },
              "rich resend failed; switching to HTML",
            );
          }
        }
        this.richMode = false;
        // Fall through to HTML — re-render this chunk on the same id (or new).
      }
    }

    // ── HTML fallback ──────────────────────────────────────────────────
    return this.sendHtml(markdown, msgId, replyMarkup);
  }

  // ── HTML transport ─────────────────────────────────────────────────

  private async sendHtml(
    markdown: string,
    msgId?: number,
    replyMarkup?: any,
  ): Promise<number | undefined> {
    const html = mdToTelegramHtml(markdown);
    const extra = {
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    };
    try {
      if (msgId !== undefined) {
        await this.api.editMessageText(
          this.chatId,
          msgId,
          html,
          extra,
        );
        return msgId;
      }
      const m = await this.api.sendMessage(this.chatId, html, extra);
      return m.message_id;
    } catch (err) {
      if (isBenign(err)) return msgId;
      // An edit that fails (e.g. the message can't be edited this way) → send
      // the chunk as a fresh HTML message instead of stalling the stream.
      try {
        const m = await this.api.sendMessage(this.chatId, html, extra);
        return m.message_id;
      } catch (e2) {
        if (isBenign(e2)) return msgId;
        logger.debug(
          { err: String(e2) },
          "HTML send failed; retrying as plain text",
        );
      }
      try {
        const m = await this.api.sendMessage(this.chatId, markdown, replyMarkup ? { reply_markup: replyMarkup } : undefined);
        return m.message_id;
      } catch (e3) {
        logger.debug({ err: String(e3) }, "plain-text send failed");
        return undefined;
      }
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function isBenign(err: unknown): boolean {
  return String(err).includes("not modified");
}

function truncateOneline(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Split `text` into chunks of at most `limit` chars, breaking at the last
 *  newline before the limit (hard-cut when there's none). Used to paginate the
 *  full rendered message across Telegram's 32k-per-message limit. */
function chunkText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    if (rest.startsWith("\n")) rest = rest.slice(1);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

