import { dirname, join } from "node:path";
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
    setTimeout(() => process.exit(1), 100);
    return;
  }
  if (config.allowedUsers.size === 0) {
    logger.warn("TELEGRAM_ALLOWED_USERS is empty — the bot will ignore everyone. Set it in .env.");
  }
  // devRoots' subdirectories are bindable too (isPathAllowed accepts any path
  // at/under a dev root), so this warning is only real when NEITHER an explicit
  // projects list NOR a dev root is configured — otherwise a fresh install
  // with a devRoot set would false-alarm "/bind will refuse all paths".
  if (config.projects.length === 0 && config.devRoots.length === 0) {
    logger.warn("No projects whitelisted in config.yaml — /bind will refuse all paths.");
  }

  const store = new Store(config.dbPath);
  approvalManager.init(store);
  // Stamp pre-multi-engine audit/task rows (engine IS NULL) with the configured
  // default engine + model so admin stats and logs show them consistently.
  store.backfillAuditDefaults(config.backend, config.claude.model);
  const swept = store.sweepStaleRunning();
  if (swept.length) logger.warn({ swept: swept.length }, "marked stale 'running' tasks as aborted (leftover from a crashed run)");
  const registry = new Registry(store, { mediaDir: join(dirname(config.dbPath), "media") });
  const recovered = store.listAllQueued().length;
  if (recovered) logger.warn({ recovered }, "recovered queued tasks from a previous run (will run as the chat drains)");
  // /cron is registered inside createBot (CronManager needs bot.api, which only
  // exists once the bot is constructed); here we just (re)schedule saved jobs.
  const { bot, cron: cronManager } = createBot(config, store, registry, proxyAgent);
  cronManager.startAll();

  const adminServer = new AdminServer(config, store, registry, cronManager);
  adminServer.start();

  bot.catch((err) => logger.error({ err: String(err.error) }, "bot error"));

  // Guard the Telegram handshake. If the proxy is down or api.telegram.org is
  // unreachable, bot.init()/getMe() would hang silently for minutes (the bot
  // process stays alive but never receives messages — i.e. "no response"). We
  // fail fast with a clear log so the cause is obvious instead of a silent hang.
  const initTimeoutMs = 25000;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Telegram init timed out after ${initTimeoutMs / 1000}s — check network/proxy to api.telegram.org`)),
        initTimeoutMs,
      );
      bot
        .init()
        .then(() => bot.api.getMe())
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
    });
  } catch (err) {
    logger.error({ err: String(err) }, "bot failed to initialize (cannot reach Telegram — check proxy/token)");
    setTimeout(() => process.exit(1), 100);
    return;
  }
  const me = await bot.api.getMe();
  logger.info(
    { username: me.username, hermes: config.hermes.enabled, permissionMode: config.claude.permissionMode, allowDangerousSkip: config.claude.allowDangerousSkip, taskTimeoutMs: config.claude.taskTimeoutMs },
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

  // If this process was restarted via Telegram, tell the originating chat the
  // bot is back up. The old instance died before it could confirm, so the id is
  // carried here via COBOT_NOTIFY_CID (set by runBotCtl on /restart). Must run
  // BEFORE startPolling() below — bot.start() blocks for the lifetime of the
  // process, so anything after it would never execute. sendMessage only needs a
  // valid token, not an active long-poll.
  const notifyCid = process.env.COBOT_NOTIFY_CID;
  if (notifyCid) {
    try {
      await bot.api.sendMessage(Number(notifyCid), "✅ CoBot 已重启成功，服务正常运行");
      logger.info({ chatId: Number(notifyCid) }, "sent restart-success notification");
    } catch (err) {
      logger.warn({ err: String(err) }, "failed to send restart-success notification");
    }
  }

  // Notify chats whose task was left 'running' when the previous process died
  // (watchdog / OOM / crash). The dead process never ran its dashboard
  // finalize, so without this the user sees a frozen "任务进行中" card and no
  // message — and assumes the task hung. Runs after the Telegram handshake so
  // sends are only attempted once the bot can actually reach Telegram. Each
  // send is isolated: one failing chatId must not block the others or startup.
  // (An intentional /restart is unaffected — cobot.sh's cmd_stop pre-sweeps
  // via sqlite3, so `swept` is empty then; this only fires on an ungraceful
  // exit that skipped cmd_stop.)
  for (const t of swept) {
    try {
      const preview = (t.prompt || "").replace(/\s+/g, " ").trim().slice(0, 80);
      const lines = [
        "⚠️ 任务因进程异常终止而中断",
        "",
        "CoBot 进程在上次执行期间意外终止（可能由看门狗 / OOM / 重启触发），该任务未能正常结束，已自动标记为中断。重新发送你的请求即可继续。",
      ];
      if (t.projectPath) lines.push("", `📁 ${t.projectPath}`);
      if (preview) lines.push(`📝 ${preview}`);
      await bot.api.sendMessage(t.chatId, lines.join("\n"));
      logger.info({ chatId: t.chatId, taskId: t.id }, "sent stale-task interrupt notification");
    } catch (err) {
      logger.warn({ chatId: t.chatId, taskId: t.id, err: String(err) }, "failed to send stale-task interrupt notification");
    }
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
  setTimeout(() => process.exit(1), 100);
});
