import type { Api } from "grammy";
import { logger } from "../util/logger.js";
import { mdToTelegramHtml, escapeMd, sanitizeStreamMarkdown } from "../util/tgfmt.js";

/** Telegram Rich Message hard limit is 32768 UTF-8 chars. We chunk at 32000. */
const TG_HARD_LIMIT = 32000;

/**
 * Streams assistant text into a Telegram chat by progressively editing a
 * single Rich Message (sendRichMessage → editMessageText with rich_message
 * payload). Falls back to HTML parse mode if Rich isn't available.
 *
 * All sends are serialized through a promise chain to avoid overlapping
 * edits / rate limits. Once a transport mode settles it stays put — no
 * flip-flopping mid-stream.
 */
export class TelegramStreamer {
  private buffer = "";
  /** Optional top-of-message meta line (e.g. "⏱️ 思考 … · 🔧 调用 N 工具"). */
  private header = "";
  private lastMessageId: number | undefined;
  private displayedLen = 0;
  private dirty = false;
  private finished = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();

  /** null = first flush not yet done; true = Rich; false = HTML fallback. */
  private richMode: boolean | null = null;

  constructor(
    private api: Api,
    private chatId: number,
    private maxEditChars: number = 32000,
    private flushMs = 900,
  ) {}

  /** Append assistant text. Auto-flushes when the buffer exceeds the edit cap. */
  text(delta: string): Promise<void> {
    if (this.finished || !delta) return Promise.resolve();
    this.buffer += delta;
    this.dirty = true;
    if (this.buffer.length >= this.maxEditChars) {
      return this.flush().then(() => {
        this.buffer = "";
        this.resetMessageTarget();
      });
    }
    this.schedule();
    return Promise.resolve();
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
   * Append a reasoning ("thinking") fragment. Used for the ① think-message so
   * the live reasoning is visible without duplicating the final answer (which
   * lives in ②). Kept as a distinct method only for semantic clarity; it routes
   * through the same transport as text().
   */
  thinkingFragment(delta: string): Promise<void> {
    return this.text(delta);
  }

  /**
   * Set/replace the top-of-message meta line. Rendered above the streamed body
   * on the next flush, so callers can update it live (e.g. as tool calls land).
   * No-op when unchanged or after finalize.
   */
  setHeader(h: string): void {
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
    this.buffer += `\n\n${markdown.replace(/\n{2,}/g, "\n")}`;
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

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return Promise.resolve();
    this.dirty = false;
    const body = this.buffer.replace(/\n{3,}/g, "\n\n");
    const text = this.header ? `${this.header}\n\n${body}` : body;
    if (!text.trim()) return Promise.resolve();
    return this.enqueue(() => this.send(text));
  }

  async finalize(): Promise<void> {
    this.finished = true;
    await this.flush();
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  // ── send-state machine ────────────────────────────────────────────────

  private async send(text: string): Promise<void> {
    if (text.length <= TG_HARD_LIMIT) {
      await this.sendStreamMessage(text, this.lastMessageId !== undefined);
      this.displayedLen = text.length;
      return;
    }
    const tail = text.slice(this.displayedLen);
    for (const chunk of chunkText(tail, TG_HARD_LIMIT)) {
      await this.sendStreamMessage(chunk, false);
    }
    this.displayedLen = text.length;
  }

  private resetMessageTarget(): void {
    this.lastMessageId = undefined;
    this.displayedLen = 0;
  }

  /**
   * Send / edit one piece of streamed markdown. Transports are tried in
   * priority order; the first success settles a mode. Once a mode is set
   * it won't flip-flop — peers or mid-stream failures falls down the stack
   * but never renegotiates back up.
   */
  private async sendStreamMessage(
    markdown: string,
    edit: boolean,
  ): Promise<void> {
    const apiAny = this.api as any;

    // ── first flush: probe Rich Messages ──────────────────────────────
    if (this.richMode === null) {
      try {
        const safe = sanitizeStreamMarkdown(markdown);
        const m = await apiAny.sendRichMessage(this.chatId, {
          markdown: safe,
        });
        this.lastMessageId = m.message_id;
        this.richMode = true;
        return;
      } catch (err) {
        if (isBenign(err)) return;
        logger.debug({ err: String(err) }, "sendRichMessage failed; using HTML");
        this.richMode = false;
        // Fall through to HTML below.
      }
    }

    // ── Rich mode — edit in place (or send new for overflow chunks) ──
    if (this.richMode) {
      try {
        const safe = sanitizeStreamMarkdown(markdown);
        if (edit && this.lastMessageId !== undefined) {
          await apiAny.editMessageText(this.chatId, this.lastMessageId, {
            markdown: safe,
          });
        } else {
          const m = await apiAny.sendRichMessage(this.chatId, {
            markdown: safe,
          });
          this.lastMessageId = m.message_id;
        }
        return;
      } catch (err) {
        if (isBenign(err)) return;
        logger.debug(
          { err: String(err) },
          "rich edit/send failed; switching to HTML",
        );
        this.richMode = false;
        this.lastMessageId = undefined;
      }
    }

    // ── HTML fallback ──────────────────────────────────────────────────
    await this.sendHtml(markdown, edit);
  }

  // ── HTML transport ─────────────────────────────────────────────────

  private async sendHtml(markdown: string, edit: boolean): Promise<void> {
    const html = mdToTelegramHtml(markdown);
    const extra = {
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
    };
    try {
      if (edit && this.lastMessageId !== undefined) {
        await this.api.editMessageText(
          this.chatId,
          this.lastMessageId,
          html,
          extra,
        );
        return;
      }
      const m = await this.api.sendMessage(this.chatId, html, extra);
      this.lastMessageId = m.message_id;
    } catch (err) {
      if (isBenign(err)) return;
      if (edit) this.lastMessageId = undefined;
      try {
        const m = await this.api.sendMessage(this.chatId, html, extra);
        this.lastMessageId = m.message_id;
        return;
      } catch (e2) {
        if (isBenign(e2)) return;
        logger.debug(
          { err: String(e2) },
          "HTML send failed; retrying as plain text",
        );
      }
      try {
        const m = await this.api.sendMessage(this.chatId, markdown);
        this.lastMessageId = m.message_id;
      } catch (e3) {
        logger.debug(
          { err: String(e3) },
          "plain-text send failed",
        );
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

/** Return true when the markdown has constructs that need Telegram's native
 *  Rich Message renderer — tables, LaTeX math, or clickable checklists.
 *  Plain bold/italic/code/lists/headings render fine via HTML parse mode. */
function needsRich(md: string): boolean {
  // GFM table: at least one "|" on two consecutive lines with a delimiter row.
  if (/^.*\|.*\n\|?\s*:?---+\s*\|/m.test(md)) return true;
  // LaTeX math: inline ($...$) or block ($$...$$).
  if (/\$\$/.test(md) || /\$[^$]+\$/m.test(md)) return true;
  // Checklist: lines starting with "- [ ]" or "- [x]".
  if (/^[\s]*[-*+]\s+\[[ x]\]/m.test(md)) return true;
  return false;
}
