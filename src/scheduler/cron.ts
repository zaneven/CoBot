import cron from "node-cron";
import { randomUUID } from "node:crypto";
import type { Api } from "grammy";
import type { Config } from "../config.js";
import type { Store, CronJob } from "../store/db.js";
import type { Registry } from "../registry/registry.js";
import { runOne } from "../bot/runs.js";
import { logger } from "../util/logger.js";

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/**
 * Manages cron-scheduled Claude Code tasks. Each job runs its prompt in its
 * bound project (resuming the same session across fires for continuity) and
 * streams the result back to the originating Telegram chat.
 */
export class CronManager {
  private tasks = new Map<string, cron.ScheduledTask>();

  constructor(
    private store: Store,
    private config: Config,
    private registry: Registry,
    private api: Api,
  ) {}

  /** Re-schedule all enabled jobs from the store (call at startup). */
  startAll(): void {
    const jobs = this.store.listAllCron();
    for (const job of jobs) this.scheduleJob(job);
    logger.info({ count: this.tasks.size }, "cron jobs scheduled");
  }

  validate(schedule: string): boolean {
    return cron.validate(schedule);
  }

  add(chatId: number, projectPath: string, schedule: string, prompt: string): CronJob {
    const job: CronJob = {
      id: randomUUID(),
      chatId,
      projectPath,
      schedule,
      prompt,
      claudeSessionId: null,
      enabled: 1,
      createdAt: Date.now(),
      lastRunAt: null,
    };
    this.store.insertCron(job);
    this.scheduleJob(job);
    return job;
  }

  list(chatId: number): CronJob[] {
    return this.store.listCron(chatId);
  }

  remove(chatId: number, id: string): boolean {
    const t = this.tasks.get(id);
    if (t) {
      t.stop();
      this.tasks.delete(id);
    }
    return this.store.deleteCron(chatId, id);
  }

  /** Stop a running cron job without deleting it from the store. */
  disable(id: string): boolean {
    const t = this.tasks.get(id);
    if (t) {
      t.stop();
      this.tasks.delete(id);
    }
    const job = this.store.getCron(id);
    if (!job) return false;
    this.store.setCronEnabled(id, 0);
    return true;
  }

  /** Re-schedule a previously disabled cron job. */
  enable(id: string): boolean {
    const job = this.store.getCron(id);
    if (!job) return false;
    if (this.tasks.has(id)) return true; // already scheduled
    this.scheduleJob(job);
    this.store.setCronEnabled(id, 1);
    return true;
  }

  private scheduleJob(job: CronJob): void {
    if (!this.validate(job.schedule)) {
      logger.warn({ id: job.id, schedule: job.schedule }, "invalid cron schedule, skipping");
      return;
    }
    const task = cron.schedule(job.schedule, () => {
      void this.fire(job.id);
    });
    this.tasks.set(job.id, task);
  }

  private async fire(jobId: string): Promise<void> {
    const job = this.store.getCron(jobId);
    if (!job) return;
    const chatId = job.chatId;

    if (this.registry.isActive(chatId)) {
      await this.api.sendMessage(chatId, `⏭ Cron skipped (a task is already running): ${truncate(job.prompt, 60)}`);
      return;
    }

    logger.info({ jobId, chatId, schedule: job.schedule }, "cron firing");
    await this.api.sendMessage(chatId, `⏰ Cron (${job.schedule}): ${truncate(job.prompt, 120)}`);

    const outcome = await runOne({
      api: this.api,
      chatId,
      projectPath: job.projectPath,
      sessionId: job.claudeSessionId,
      prompt: { text: job.prompt },
      displayText: `[cron] ${truncate(job.prompt, 40)}`,
      config: this.config,
      registry: this.registry,
      store: this.store,
      origin: "cron",
      onSessionId: (id) => {
        this.store.setCronSessionId(jobId, id);
      },
    });

    this.store.setCronLastRun(jobId, Date.now());
    logger.info({ jobId, outcome: outcome.status }, "cron finished");
  }

  stopAll(): void {
    for (const t of this.tasks.values()) t.stop();
    this.tasks.clear();
  }
}
