import { execSync } from "node:child_process";
import type { Agent } from "node:https";
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
  try {
    const out = execSync("scutil --proxy", { timeout: 2000 }).toString();
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

/** Create a node-fetch-compatible proxy agent, or undefined for direct. */
export function createProxyAgent(): Agent | undefined {
  const url = detectProxyUrl();
  if (!url) {
    logger.warn(
      "no HTTP proxy detected (checked COBOT_PROXY/HTTPS_PROXY/scutil); " +
        "Telegram is only reachable via a proxy on this network — bot may hang silently on outbound calls. " +
        "Set COBOT_PROXY or enable the system proxy.",
    );
    return undefined;
  }
  const agent: Agent = url.startsWith("socks")
    ? new SocksProxyAgent(url)
    : new HttpsProxyAgent(url);
  logger.info({ proxy: url }, "proxy agent enabled for Telegram (node-fetch)");
  return agent;
}
