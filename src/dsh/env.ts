import { detectProxyUrl } from "../util/proxy.js";

/**
 * The environment the dsh runtime inherits.
 *
 * AGENTS.md §6 requires every outbound HTTP client to go through the local
 * proxy; dsh's own `dsh-http-proxy` reads the standard variables, so exporting
 * them is enough (no custom agent injection). `DSH_PERMISSION_MODE` selects the
 * sandbox preset — it is read once at spawn, so it is process-wide, not per run.
 */
export function buildDshEnv(opts: {
  permissionMode?: string;
  baseEnv?: NodeJS.ProcessEnv;
  proxyUrl?: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(opts.baseEnv ?? process.env), NO_COLOR: "1", FORCE_COLOR: "0" };
  const proxy = opts.proxyUrl === "" ? undefined : (opts.proxyUrl ?? detectProxyUrl());
  if (proxy) {
    env.HTTP_PROXY = env.HTTP_PROXY || proxy;
    env.HTTPS_PROXY = env.HTTPS_PROXY || proxy;
    env.http_proxy = env.http_proxy || proxy;
    env.https_proxy = env.https_proxy || proxy;
  }
  if (opts.permissionMode) env.DSH_PERMISSION_MODE = opts.permissionMode;
  return env;
}
