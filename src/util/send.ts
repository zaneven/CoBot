import type { Api } from "grammy";
import { logger } from "./logger.js";
import { mdToTelegramHtml, sanitizeStreamMarkdown } from "./tgfmt.js";

/** Split `text` into chunks of at most `limit` chars, breaking at the last newline. */
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

async function sendOneChunk(
  api: Api,
  chatId: number,
  text: string,
  replyMarkup?: any,
): Promise<number> {
  const apiAny = api as any;

  // 1. Rich Message (native markdown). NOTE: sendRichMessage silently drops
  //    reply_markup (buttons never render on rich messages), so the keyboard
  //    is attached separately via the standard editMessageReplyMarkup below.
  try {
    const m = await apiAny.sendRichMessage(chatId, { markdown: sanitizeStreamMarkdown(text) });
    if (replyMarkup) {
      try {
        await apiAny.editMessageReplyMarkup(chatId, m.message_id, undefined, { reply_markup: replyMarkup });
      } catch (err) {
        // Can't attach markup to this rich message - fall back to a separate
        // plain message carrying the buttons (the pre-rewrite, proven path).
        logger.debug({ err: String(err) }, "sendRichText: could not attach markup to rich message");
        await api.sendMessage(chatId, "💡 建议的下一步操作：", replyMarkup ? { reply_markup: replyMarkup } : undefined);
      }
    }
    return m.message_id;
  } catch (err) {
    logger.debug({ err: String(err) }, "sendRichText: rich failed, falling to HTML");
  }

  // 2. HTML parse mode — tables / LaTeX render as flattened, readable text so
  //    no structural information is lost when Rich isn't available.
  try {
    const html = mdToTelegramHtml(text);
    const m = await api.sendMessage(chatId, html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return m.message_id;
  } catch (err) {
    logger.debug({ err: String(err) }, "sendRichText: HTML failed, falling to plain text");
  }

  // 3. Plain text (last resort)
  const m = await api.sendMessage(chatId, text, replyMarkup ? { reply_markup: replyMarkup } : undefined);
  return m.message_id;
}

/**
 * Send a one-shot message using Telegram's native Rich Message renderer
 * (sendRichMessage), falling back to HTML → plain text if the rich API
 * isn't available on this server.
 *
 * Use this for messages that contain markdown: code blocks, tables, bold,
 * LaTeX, etc. For simple plain‑text status lines, `api.sendMessage` is fine.
 *
 * Unlike `TelegramStreamer`, this is a one-shot fire‑and‑forget call — no
 * progressive edits. It shares the same 3‑tier fallback stack, and applies the
 * same `sanitizeStreamMarkdown` pass as the streamer so a Rich payload that
 * contains an unbalanced fence or a partial link won't be rejected.
 */
export async function sendRichText(
  api: Api,
  chatId: number,
  text: string,
  replyMarkup?: any,
): Promise<number> {
  const chunks = chunkText(text, 3800);
  let lastId = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const isLast = i === chunks.length - 1;
    const markup = isLast ? replyMarkup : undefined;
    lastId = await sendOneChunk(api, chatId, chunk, markup);
  }
  return lastId;
}