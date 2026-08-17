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
  /** Reasoning ("thinking") bookkeeping. The full (often English)
   *  chain-of-thought is folded away — we only track that thinking is happening
   *  and for how long, surfacing a compact "💭 思考过程" block (fold note +
   *  running duration) above the answer body. The per-step progress the user
   *  actually wants lives in the answer body itself, one turn per line (see
   *  {@link newline}); reasoning never pollutes it. */
  private thinkingActive = false;
  private thinkingStartMs = 0;
  private thinkingTotalMs = 0;
  private hadThinking = false;
  /** The complete answer text accumulated across all agentic turns — the
   *  single source of truth. Never cleared (the old auto-flush that reset this
   *  was what made `ensureContains` re-append the whole answer and duplicate
   *  content). Overflow into multiple messages is handled by paginating this
   *  at the 32k limit, not by discarding what was already streamed. */
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

  toolLine(name: string, summary: string): Promise<void> {
    return this.text(`\n\n🔧 **${escapeMd(name)}** › ${escapeMd(summary)}`);
  }

  toolResult(name: string, content: string, isError: boolean): Promise<void> {
    const mark = isError ? "⚠️" : "↳";
    return this.text(
      `\n\n${mark} **${escapeMd(name)}** · ${escapeMd(truncateOneline(content, 400))}`,
    );
  }

  /**
   * Record a reasoning ("thinking") fragment. The full chain-of-thought is
   * folded away — only the fact that thinking is happening and its running
   * duration surface in the "💭 思考过程" blockquote above the answer body.
   * This breaks the long silence where a 20-minute think is indistinguishable
   * from a hung task without dumping raw (often English) reasoning into the
   * chat. The step-by-step progress the user wants comes from the answer body
   * (each turn's narration, one per line via {@link newline}), not from here.
   * Kept separate from {@link text} so reasoning never pollutes the answer.
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
   * running total. Called whenever non-reasoning content arrives (answer text,
   * a tool call via {@link setHeader}, the run ending) so the duration reflects
   * only actual thinking time, not the tool execution around it. No-op when no
   * thinking span is open.
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

  /** Compose the full logical message: header, folded thinking block, body. */
  private render(): string {
    const sections = [
      this.renderThinking(),
      this.content.replace(/\n{3,}/g, "\n\n"),
    ].filter((s) => s.trim());
    const body = sections.join("\n\n");
    return this.header ? `${this.header}\n\n${body}` : body;
  }

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
      if (m.id === undefined) {
        const id = await this.sendStreamMessage(want);
        m.id = id;
        m.text = want;
      } else if (m.text !== want) {
        await this.sendStreamMessage(want, m.id);
        m.text = want;
      }
      // else: unchanged frozen chunk — skip the edit entirely.
    }
  }

  /**
   * Render the thinking blockquote: the full chain-of-thought folded away (a
   * one-line note says so) and the total thinking time on the last line. Each
   * line is prefixed with `>` so Telegram draws a bordered quote in both Rich
   * Message and HTML transports. Returns "" when no thinking happened this run
   * (non-reasoning turns add nothing to the message).
   */
  private renderThinking(): string {
    if (!this.hadThinking) return "";
    const live = this.thinkingActive ? Date.now() - this.thinkingStartMs : 0;
    const totalMs = this.thinkingTotalMs + live;
    return [
      "> **💭 思考过程**",
      "> _…详细思考内容已折叠_",
      `> _⏱️ 思考用时 ${fmtDuration(totalMs)}_`,
    ].join("\n");
  }

  async finalize(): Promise<void> {
    this.closeThinking();
    this.finished = true;
    await this.flush();
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
   * Transports are tried in priority order; once settled it won't flip-flop —
   * a mid-stream failure falls down to HTML but never renegotiates back up.
   */
  private async sendStreamMessage(
    markdown: string,
    msgId?: number,
  ): Promise<number | undefined> {
    const apiAny = this.api as any;
    const edit = msgId !== undefined;

    // ── first flush: probe Rich Messages ──────────────────────────────
    if (this.richMode === null) {
      try {
        const safe = sanitizeStreamMarkdown(markdown);
        const m = await apiAny.sendRichMessage(this.chatId, {
          markdown: safe,
        });
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
        const safe = sanitizeStreamMarkdown(markdown);
        if (edit) {
          await apiAny.editMessageText(this.chatId, msgId, {
            markdown: safe,
          });
          return msgId;
        }
        const m = await apiAny.sendRichMessage(this.chatId, {
          markdown: safe,
        });
        return m.message_id;
      } catch (err) {
        if (isBenign(err)) return msgId;
        logger.debug(
          { err: String(err) },
          "rich edit/send failed; switching to HTML",
        );
        this.richMode = false;
        // Fall through to HTML — re-render this chunk on the same id (or new).
      }
    }

    // ── HTML fallback ──────────────────────────────────────────────────
    return this.sendHtml(markdown, msgId);
  }

  // ── HTML transport ─────────────────────────────────────────────────

  private async sendHtml(
    markdown: string,
    msgId?: number,
  ): Promise<number | undefined> {
    const html = mdToTelegramHtml(markdown);
    const extra = {
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
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
        const m = await this.api.sendMessage(this.chatId, markdown);
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

