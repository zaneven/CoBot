import { Bot, GrammyError, type Transformer } from "grammy";
import type { Agent } from "node:https";
import type { Config } from "../config.js";
import type { Store } from "../store/db.js";
import type { Registry } from "../registry/registry.js";
import { CronManager } from "../scheduler/cron.js";
import { logger } from "../util/logger.js";
import { approvalManager } from "./approval.js";
import { dialogManager } from "./dialog.js";
import {
  handleStart,
  handleHelp,
  handleProjects,
  handleProject,
  handleProjectCallback,
  handleProjectPageCallback,
  handleBind,
  handleUnbind,
  handleNew,
  handleStop,
  handleTasks,
  handleQueue,
  handleDrop,
  handleEngine,
  handleEngineCallback,
  handleSessions,
  handleSwitch,
  handleSwitchCallback,
  handleCron,
  handleText,
  handleAuto,
  handleContext,
  handleSkills,
  handleSkillsPage,
  handleModels,
  handleModelCallback,
  handleNewProjectClick,
  handleApprove,
  handleApproveModeCallback,
  handleBot,
  handleNextActionCallback,
} from "./commands.js";
import { handlePhoto, handleDocument } from "./media.js";

export function createBot(
  config: Config,
  store: Store,
  registry: Registry,
  agent?: Agent,
): { bot: Bot; cron: CronManager } {
  const bot = new Bot(
    config.telegramToken,
    agent ? { client: { baseFetchConfig: { agent } } } : {},
  );

  // Retry 429 (Too Many Requests) honoring Telegram's retry_after. grammY only
  // retries the long-poll loop itself, not individual sendMessage/editMessageText
  // calls, so without this a burst of streaming edits fails outright when limited.
  bot.api.config.use(retryOn429);

  // Authorization gate.
  bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    if (config.allowedUsers.size > 0 && !config.allowedUsers.has(ctx.from.id)) {
      logger.warn({ userId: ctx.from.id, username: ctx.from.username }, "unauthorized user ignored");
      return;
    }
    return next();
  });

  bot.command("start", (ctx) => handleStart(ctx));
  bot.command("help", (ctx) => handleHelp(ctx));
  bot.command("projects", (ctx) => handleProjects(ctx, config, store));
  bot.command("project", (ctx) => handleProject(ctx, config, store));
  bot.callbackQuery(/^proj:/, (ctx) => handleProjectCallback(ctx, config, store));
  // Pagination buttons from /projects (projpg:<page> = prev/next, projpi:<page> = page indicator).
  bot.callbackQuery(/^projp[gi]:/, (ctx) => handleProjectPageCallback(ctx, config, store));
  bot.command("bind", (ctx) => handleBind(ctx, config, store));
  bot.command("unbind", (ctx) => handleUnbind(ctx, store));
  bot.command("new", (ctx) => handleNew(ctx, store));
  bot.command("auto", (ctx) => handleAuto(ctx, config, store, registry));
  bot.command("engine", (ctx) => handleEngine(ctx, config, store));
  bot.callbackQuery(/^engine:/, (ctx) => handleEngineCallback(ctx, config, store));
  bot.command("stop", (ctx) => handleStop(ctx, registry));
  bot.command("tasks", (ctx) => handleTasks(ctx, store, registry));
  bot.command("queue", (ctx) => handleQueue(ctx, registry));
  bot.command("drop", (ctx) => handleDrop(ctx, registry));
  bot.command("sessions", (ctx) => handleSessions(ctx, config, store));
  bot.command("switch", (ctx) => handleSwitch(ctx, config, store));
  // Inline-button callback from /sessions (sw:<sessionId>).
  bot.callbackQuery(/^sw:/, (ctx) => handleSwitchCallback(ctx, config, store));

  // CronManager needs bot.api, so construct it now that the bot exists and
  // register /cron here alongside every other command (the auth middleware above
  // still wraps it).
  const cron = new CronManager(store, config, registry, bot.api);
  bot.command("cron", (ctx) => handleCron(ctx, store, cron));
  bot.command("context", (ctx) => handleContext(ctx, registry));
  bot.command("skills", (ctx) => handleSkills(ctx));
  bot.command("models", (ctx) => handleModels(ctx, config, store));
  bot.command("approve", (ctx) => handleApprove(ctx, store));
  bot.command("bot", (ctx) => handleBot(ctx));
  // /restart is a convenience alias for /bot restart.
  bot.command("restart", (ctx) => handleBot(ctx, "restart"));

  // /skills pagination: prev/next buttons (skp:<page>).
  bot.callbackQuery(/^skp:/, (ctx) => handleSkillsPage(ctx));

  // /models model pick (model:<index> into the config list, or
  // model:__default__ to clear the per-chat override).
  bot.callbackQuery(/^model:/, (ctx) => handleModelCallback(ctx, config, store));

  // Inline-button approval decisions (appr:<shortId>:<action>).
  bot.callbackQuery(/^appr:/, (ctx) => approvalManager.handleCallback(ctx));

  // Inline-button AskUserQuestion option/action taps (ask:<shortId>:…).
  bot.callbackQuery(/^ask:/, (ctx) => dialogManager.handleCallback(ctx));

  // /approve mode toggle (approve:<auto|interactive>) — distinct prefix from
  // the tool-approval `appr:` above so the two never collide.
  bot.callbackQuery(/^approve:/, (ctx) => handleApproveModeCallback(ctx, store));

  // Suggested next-step buttons (next:<id>) rendered under a finished result.
  bot.callbackQuery(/^next:/, (ctx) => handleNextActionCallback(ctx, { config, store, registry }));

  // /projects "新建项目" button.
  bot.callbackQuery("newproj", (ctx) => handleNewProjectClick(ctx));

  // Dashboard [⏹ 中断当前任务] button callback.
  bot.callbackQuery(/^stop_task:/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "正在中断任务…" });
    await handleStop(ctx, registry);
  });

  // Inline query handler — required for switchInlineCurrent buttons in /skills.
  bot.on("inline_query", async (ctx) => {
    const q = ctx.inlineQuery.query.trim();
    await ctx.answerInlineQuery(
      [
        {
          type: "article",
          id: "1",
          title: q || "type your query",
          input_message_content: { message_text: q || "(empty)" },
        },
      ],
      { cache_time: 0 },
    );
  });

  // Keyboard‑button presses — map labels to existing handlers (supports English and Chinese).
  bot.hears(/^(New|新建)$/i,        (ctx) => handleNew(ctx, store));
  bot.hears(/^(Stop|停止)$/i,       (ctx) => handleStop(ctx, registry));
  bot.hears(/^(Sessions?|会话)$/i,  (ctx) => handleSessions(ctx, config, store));
  bot.hears(/^(Projects?|项目)$/i,  (ctx) => handleProjects(ctx, config, store));
  bot.hears(/^(Engine|引擎)$/i,     (ctx) => handleEngine(ctx, config, store));
  bot.hears(/^(Queue|队列)$/i,      (ctx) => handleQueue(ctx, registry));
  bot.hears(/^(Tasks?|任务)$/i,     (ctx) => handleTasks(ctx, store, registry));
  bot.hears(/^(Approve|审批)$/i,    (ctx) => handleApprove(ctx, store));

  bot.on("message:text", (ctx) => handleText(ctx, config, store, registry));
  // Photos and documents (screenshots / PDFs / text files) become multimodal prompts.
  bot.on("message:photo", (ctx) => handlePhoto(ctx, config, store, registry, agent));
  bot.on("message:document", (ctx) => handleDocument(ctx, config, store, registry, agent));

  return { bot, cron };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Transformer that retries 429 responses with retry_after backoff (capped). */
const retryOn429: Transformer = async (prev, method, payload, signal) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prev(method, payload, signal);
    } catch (err) {
      if (!(err instanceof GrammyError) || err.error_code !== 429) throw err;
      const secs = typeof err.parameters?.retry_after === "number" ? err.parameters.retry_after : 1;
      await sleep(Math.min(secs, 10) * 1000);
    }
  }
  return prev(method, payload, signal);
};
