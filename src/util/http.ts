import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";
import type { Agent } from "node:https";

/**
 * Download a URL into a Buffer using the given (proxy) agent. Used for
 * Telegram file downloads: grammY's `getFile` returns a `file_path`, and the
 * bytes live at `https://api.telegram.org/file/bot<token>/<file_path>` - a
 * plain GET that must go through the same proxy agent as the rest of the bot
 * (the direct path to Telegram is TLS-intercepted/blocked on this machine).
 *
 * Uses node:https/http directly rather than node-fetch so no extra dependency
 * (or @types) is needed, and the existing `HttpsProxyAgent`/`SocksProxyAgent`
 * (which are node:https `Agent`s) plug straight in.
 */
export function downloadBuffer(url: string, agent?: Agent, timeoutMs = 30_000): Promise<Buffer> {
  const get = url.startsWith("https:") ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const req = get(url, { agent }, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        reject(new Error(`download ${url} failed: HTTP ${status}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`download timed out after ${timeoutMs}ms: ${url}`)));
  });
}
