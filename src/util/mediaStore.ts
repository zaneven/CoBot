import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MediaAttachment, ImageMime } from "../claude/types.js";

/**
 * Media attachments carried by a queued prompt are Buffers, which we don't want
 * to serialize into the DB. Instead we write each buffer to a temp file under
 * `mediaDir/<taskId>/<i>` and persist only the file paths (as JSON). On deque
 * the buffers are read back, so the queue row stays small and restart-safe.
 */

export interface PersistedMedia {
  kind: MediaAttachment["kind"];
  mediaType?: string;
  fileName?: string;
  path: string;
}

/** Write media buffers to disk and return the JSON to store in the queue row. */
export function persistMedia(id: string, media: MediaAttachment[], mediaDir: string): string | null {
  if (!media || media.length === 0) return null;
  const dir = join(mediaDir, id);
  mkdirSync(dir, { recursive: true });
  const items: PersistedMedia[] = media.map((m, i) => {
    const path = join(dir, String(i));
    writeFileSync(path, m.data);
    return { kind: m.kind, mediaType: "mediaType" in m ? m.mediaType : undefined, fileName: m.fileName, path };
  });
  return JSON.stringify(items);
}

/** Reconstruct media buffers from a stored JSON blob (or undefined if none). */
export function loadMedia(json: string | null, mediaDir: string): MediaAttachment[] | undefined {
  if (!json) return undefined;
  const items = JSON.parse(json) as PersistedMedia[];
  return items.map((it) => {
    const data = readFileSync(it.path);
    switch (it.kind) {
      case "image":
        return { kind: "image", mediaType: (it.mediaType ?? "image/jpeg") as ImageMime, data, fileName: it.fileName };
      case "pdf":
        return { kind: "pdf", data, fileName: it.fileName };
      case "text":
        return { kind: "text", mediaType: it.mediaType ?? "text/plain", data, fileName: it.fileName ?? "file.txt" };
    }
  });
}

/** Best-effort removal of a task's media dir (after the task is dequeued). */
export function removeMediaDir(id: string, mediaDir: string): void {
  try {
    rmSync(join(mediaDir, id), { recursive: true, force: true });
  } catch {
    /* orphan cleanup is best-effort */
  }
}