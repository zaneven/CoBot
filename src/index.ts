import { loadConfig } from "./config.js";
import { Store } from "./store/db.js";
import { Registry } from "./registry/registry.js";
import { createBot } from "./bot/bot.js";
import { BOT_COMMANDS } from "./bot/commands.js";
import { approvalManager } from "./bot/approval.js";
import { logger } from "./util/logger.js";
import { createProxyAgent } from "./util/proxy.js";
import { AdminServer } from "./admin/server.js";

async function main(): Promise<void> {
  const proxyAgent = createProxyAgent();
  const config = loadConfig();

  if (!config.telegramToken) {
    logger.error("TELEGRAM_BOT_TOKEN not set. Copy .env.example to .env and configure it.");
    process.exit(1);
  }
  if (config.allowedUsers.size === 0) {
    logger.warn("TELEGRAM_ALLOWED_USERS is empty — the bot will ignore everyone. Set it in .env.");
  }
  if (config.projects.length === 0) {
    logger.warn("No projects whitelisted in config.yaml — /bind will refuse all paths.");
  }

  const store = new Store(config.dbPath);
  approvalManager.init(store);
  const swept = store.sweepStaleRunning();
  if (swept) logger.warn({ swept }, "marked stale 'running' tasks as aborted (leftover from a crashed run)");
  const registry = new Registry(store);
  // /cron is registered inside createBot (CronManager needs bot.api, which only
  // exists once the bot is constructed); here we just (re)schedule saved jobs.
  const { bot, cron: cronManager } = createBot(config, store, registry, proxyAgent);
  cronManager.startAll();

  const adminServer = new AdminServer(config, store, registry, cronManager);
  adminServer.start();

  bot.catch((err) => logger.error({ err: String(err.error) }, "bot error"));

  await bot.init();
  const me = await bot.api.getMe();
  logger.info(
    { username: me.username, hermes: config.hermes.enabled, taskTimeoutMs: config.claude.taskTimeoutMs },
    "CoBot bot started",
  );

  // Register the command menu (the "/" quick-input list). Non-fatal: the bot
  // still works if this fails (e.g. transient network error).
  try {
    await bot.api.setMyCommands(
      BOT_COMMANDS.map(({ command, description }) => ({ command, description })),
    );
    logger.info({ count: BOT_COMMANDS.length }, "registered bot command menu");
  } catch (err) {
    logger.warn({ err: String(err) }, "failed to register bot command menu");
  }

  let shuttingDown = false;
  const stop = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, "shutting down");
    adminServer.stop();
    cronManager.stopAll();
    try {
      await bot.stop();
    } catch {
      // Ignore stop errors (e.g. 409 Conflict during tsx watch reload)
    }
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  // Long-polling with a SEPARATE token — coexists with Hermes's Telegram platform.
  const startPolling = async (retries = 3): Promise<void> => {
    try {
      await bot.start({
        drop_pending_updates: false,
        allowed_updates: ["message", "callback_query"],
        timeout: config.telegram.pollTimeout,
      });
    } catch (err: unknown) {
      if (retries > 0 && String(err).includes("409: Conflict")) {
        logger.warn("Telegram 409 Conflict (previous bot instance disconnecting), retrying in 3s...");
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return startPolling(retries - 1);
      }
      throw err;
    }
  };
  await startPolling();
}

main().catch((err) => {
  logger.error({ err: String(err) }, "fatal startup error");
  process.exit(1);
});
