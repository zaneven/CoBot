import type { Context } from "grammy";
import type { Agent } from "node:https";
import type { Config } from "../config.js";
import type { Store } from "../store/db.js";
import type { Registry } from "../registry/registry.js";
import type { MediaAttachment, ImageMime } from "../claude/types.js";
import { submitInteractive } from "./runs.js";
import { downloadBuffer } from "../util/http.js";
import { logger } from "../util/logger.js";

const FILE_DOWNLOAD_BASE = "https://api.telegram.org/file/bot";

/** Telegram's largest PhotoSize is picked by the largest file_size. */
export function largestPhotoId(sizes: readonly { file_id: string; file_size?: number; width?: number; height?: number }[]): string {
  return [...sizes].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]!.file_id;
}

/**
 * Heuristic: a replacement-char ratio over 5% means the buffer decodes as
 * corrupted UTF-8 — it's binary, not readable text.
 */
export function looksLikeBinary(buf: Buffer): boolean {
  let body: string;
  try {
    body = buf.toString("utf8");
  } catch {
    return true;
  }
  return body.replace(/[^�]/g, "").length > Math.max(1, body.length) * 0.05;
}

const IMAGE_MIME: Record<string, ImageMime> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

/**
 * Handle a photo: download the largest variant, build an image attachment, and
 * submit it as a prompt (with the caption as the text). Goes through the same
 * queue/non-blocking path as text, so /stop and /queue keep working.
 */
export async function handlePhoto(ctx: Context, config: Config, store: Store, registry: Registry, agent?: Agent): Promise<void> {
  const chatId = ctx.chat?.id;
  const photo = ctx.message?.photo;
  if (!chatId || !photo?.length) return;
  if (!store.getBinding(chatId)) {
    await ctx.reply("No project selected. Use /projects to pick one.");
    return;
  }
  const fileId = largestPhotoId(photo);
  const caption = ctx.message?.caption?.trim() ?? "";
  try {
    const { file_path } = await ctx.api.getFile(fileId);
    if (!file_path) throw new Error("getFile returned no file_path");
    const data = await downloadBuffer(`${FILE_DOWNLOAD_BASE}${config.telegramToken}/${file_path}`, agent);
    const text = caption || "Look at this image and tell me about it.";
    submitInteractive({
      api: ctx.api,
      chatId,
      prompt: { text, media: [{ kind: "image", mediaType: "image/jpeg", data, fileName: "photo.jpg" }] },
      displayText: caption ? `📷 ${caption}` : "📷 [photo]",
      config,
      registry,
      store,
    });
  } catch (err) {
    logger.error({ err: String(err) }, "photo download failed");
    await ctx.reply(`❌ Couldn't download the photo: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Handle a document (file): images and PDFs become typed attachments; anything
 * else is inlined as text if it decodes as UTF-8, else rejected.
 */
export async function handleDocument(
  ctx: Context,
  config: Config,
  store: Store,
  registry: Registry,
  agent?: Agent,
): Promise<void> {
  const chatId = ctx.chat?.id;
  const doc = ctx.message?.document;
  if (!chatId || !doc) return;
  if (!store.getBinding(chatId)) {
    await ctx.reply("No project selected. Use /projects to pick one.");
    return;
  }
  const fileName = doc.file_name ?? "file";
  const mime = doc.mime_type ?? "";
  if (doc.file_size && doc.file_size > 19_500_000) {
    await ctx.reply("❌ That file is over Telegram's 20MB bot download limit.");
    return;
  }
  try {
    const { file_path } = await ctx.api.getFile(doc.file_id);
    if (!file_path) throw new Error("getFile returned no file_path");
    const data = await downloadBuffer(`${FILE_DOWNLOAD_BASE}${config.telegramToken}/${file_path}`, agent);
    const caption = ctx.message?.caption?.trim() ?? "";
    const intro = `📄 ${fileName}${caption ? ` — ${caption}` : ""}`;

    let media: MediaAttachment;
    if (IMAGE_MIME[mime]) media = { kind: "image", mediaType: IMAGE_MIME[mime], data, fileName };
    else if (mime === "application/pdf") media = { kind: "pdf", data, fileName };
    else {
      // Reject binary files — guaranteed to render as garbage.
      if (looksLikeBinary(data)) {
        await ctx.reply(`❌ ${fileName} looks like a binary file. Send images, PDFs, or UTF-8 text files.`);
        return;
      }
      const body = data.toString("utf8");
      media = { kind: "text", mediaType: mime || "text/plain", data: Buffer.from(body, "utf8"), fileName };
    }
    submitInteractive({ api: ctx.api, chatId, prompt: { text: caption || intro, media: [media] }, displayText: intro, config, registry, store });
  } catch (err) {
    logger.error({ err: String(err) }, "document download failed");
    await ctx.reply(`❌ Couldn't download ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
