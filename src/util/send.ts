import type { Api } from "grammy";
import { logger } from "./logger.js";
import { mdToTelegramHtml } from "./tgfmt.js";

/**
 * Send a one-shot message using Telegram's native Rich Message renderer
 * (sendRichMessage), falling back to HTML → plain text if the rich API
 * isn't available on this server.
 *
 * Use this for messages that contain markdown: code blocks, tables, bold,
 * LaTeX, etc. For simple plain‑text status lines, `api.sendMessage` is fine.
 *
 * Unlike `TelegramStreamer`, this is a one-shot fire‑and‑forget call — no
 * progressive edits. It shares the same 3‑tier of the same fallback stack.
 */
export async function sendRichText(
  api: Api,
  chatId: number,
  text: string,
): Promise<number> {
  const apiAny = api as any;

  // 1. Rich Message (native markdown)
  try {
    const m = await apiAny.sendRichMessage(chatId, { markdown: text });
    return m.message_id;
  } catch (err) {
    logger.debug({ err: String(err) }, "sendRichText: rich failed, falling to HTML");
  }

  // 2. HTML parse mode
  try {
    const html = mdToTelegramHtml(text);
    const m = await api.sendMessage(chatId, html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return m.message_id;
  } catch (err) {
    logger.debug({ err: String(err) }, "sendRichText: HTML failed, falling to plain text");
  }

  // 3. Plain text (last resort)
  const m = await api.sendMessage(chatId, text);
  return m.message_id;
}