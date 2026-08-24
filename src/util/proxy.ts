import { execSync } from "node:child_process";
import { get as httpsGet, type Agent } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { logger } from "./logger.js";

/**
 * grammY 1.45 uses `node-fetch` (not undici/global fetch), so undici's
 * `setGlobalDispatcher` has NO effect on it, and its default `baseFetchConfig`
 * ships a direct `https.Agent`. On networks where Telegram is only reachable
 * via a local proxy, that direct agent hangs on the TLS-intercepted path
 * (grammY's 500s timeout = silent "no response").
 *
 * Fix: detect the proxy and pass a proxy `agent` into grammY's
 * `baseFetchConfig.agent`, overriding the direct agent.
 */

function envProxy(): string | undefined {
  for (const k of ["COBOT_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    const v = process.env[k];
    if (v) return v;
  }
  return undefined;
}

function macSystemProxy(): string | undefined {
  // scutil is macOS-only. On Linux the shell prints "/bin/sh: scutil: command
  // not found" into the startup log for no value — short-circuit before the
  // exec so non-mac hosts never spawn it. stdio stderr=ignore is a further
  // guard against scutil diagnostics leaking on macOS.
  if (process.platform !== "darwin") return undefined;
  try {
    const out = execSync("scutil --proxy", {
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    const get = (re: RegExp): string | undefined => {
      const m = out.match(re);
      return m?.[1]?.trim();
    };
    const httpsEnabled = get(/HTTPSEnable\s*:\s*(\d+)/);
    const httpsHost = get(/HTTPSProxy\s*:\s*(\S+)/);
    const httpsPort = get(/HTTPSPort\s*:\s*(\d+)/);
    if (httpsEnabled === "1" && httpsHost && httpsPort) return `http://${httpsHost}:${httpsPort}`;
    const httpEnabled = get(/HTTPEnable\s*:\s*(\d+)/);
    const httpHost = get(/HTTPProxy\s*:\s*(\S+)/);
    const httpPort = get(/HTTPPort\s*:\s*(\d+)/);
    if (httpEnabled === "1" && httpHost && httpPort) return `http://${httpHost}:${httpPort}`;
  } catch {
    // not macOS or scutil unavailable
  }
  return undefined;
}

export function detectProxyUrl(): string | undefined {
  return envProxy() ?? macSystemProxy();
}

/** Probe whether api.telegram.org answers over a direct connection (no proxy).
 *  Non-blocking: resolves later so startup isn't delayed. Any HTTP response
 *  counts as reachable; timeout/error = blocked. The socket is unref'd so this
 *  never keeps the process alive past shutdown. */
function probeTelegramDirect(timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpsGet("https://api.telegram.org/", { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("socket", (s) => s.unref());
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

/** Create a node-fetch-compatible proxy agent, or undefined for direct. */
export function createProxyAgent(): Agent | undefined {
  const url = detectProxyUrl();
  if (!url) {
    // Don't alarm here — a direct connection is the common case (most networks
    // reach Telegram fine). Fire a background probe so the log reflects the REAL
    // state instead of a premature "no proxy" warning; the authoritative check
    // remains bot.init()/getMe()'s 25s timeout in index.ts.
    void probeTelegramDirect().then((ok) => {
      if (ok) logger.info("Telegram reachable via direct connection (no proxy needed).");
      else
        logger.warn(
          "Telegram NOT reachable via direct connection and no proxy configured — " +
            "if the bot hangs, set COBOT_PROXY or enable the system proxy.",
        );
    });
    return undefined;
  }
  const agent: Agent = url.startsWith("socks")
    ? new SocksProxyAgent(url)
    : new HttpsProxyAgent(url);
  logger.info({ proxy: url }, "proxy agent enabled for Telegram (node-fetch)");
  return agent;
}
