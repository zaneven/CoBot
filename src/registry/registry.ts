import { randomUUID } from "node:crypto";
import type { Store, RunningTask } from "../store/db.js";
import type { PromptInput } from "../claude/types.js";
import { persistMedia, loadMedia, removeMediaDir } from "../util/mediaStore.js";

export interface ActiveRun {
  taskId: string;
  chatId: number;
  projectPath: string;
  abortController: AbortController;
  startedAt: number;
  sessionId?: string;
  /** Short label shown by /queue (the prompt or "[cron] …"). */
  displayText: string;
}

/** A prompt to enqueue. `projectPath`/`origin`/`cronJobId` persist intent so the
 *  drainer can resume the right project/cron session after a restart. */
export interface QueueItem {
  prompt: PromptInput;
  displayText: string;
  projectPath?: string | null;
  origin?: "interactive" | "cron";
  cronJobId?: string | null;
}

/** A dequeued queue entry, ready to run (media buffers already read back). */
export interface Dequeued {
  taskId: string;
  prompt: PromptInput;
  displayText: string;
  projectPath: string | null;
  origin: "interactive" | "cron";
  cronJobId: string | null;
}

/**
 * Tracks the currently-running Claude Code task per Telegram chat plus a FIFO
 * queue of pending prompts. One active task per chat; further prompts enqueue
 * and drain when the active task finishes. The queue is persisted in SQLite
 * (via Store), so pending items survive a process restart: rows are simply
 * picked up again on drain. The active task is swept to 'aborted' by
 * Store.sweepStaleRunning at startup. Registry keeps only runtime state
 * (AbortController, auto-mode toggles, per-chat context pct).
 */
export class Registry {
  private active = new Map<number, ActiveRun>();

  constructor(
    private store: Store,
    private opts: { mediaDir?: string } = {},
  ) {}

  isActive(chatId: number): boolean {
    return this.active.has(chatId);
  }

  get(chatId: number): ActiveRun | undefined {
    return this.active.get(chatId);
  }

  start(chatId: number, projectPath: string, sessionId: string | null, prompt: PromptInput, displayText: string): ActiveRun {
    const taskId = randomUUID();
    const abortController = new AbortController();
    const run: ActiveRun = {
      taskId,
      chatId,
      projectPath,
      abortController,
      startedAt: Date.now(),
      sessionId: sessionId ?? undefined,
      displayText,
    };
    const task: RunningTask = {
      id: taskId,
      chatId,
      projectPath,
      sessionId,
      // The DB stores the text portion of the prompt; media isn't persisted.
      prompt: prompt.text,
      status: "running",
      startedAt: run.startedAt,
      endedAt: null,
    };
    this.store.insertTask(task);
    this.active.set(chatId, run);
    return run;
  }

  setSessionId(chatId: number, sessionId: string): void {
    const run = this.active.get(chatId);
    if (run) run.sessionId = sessionId;
    this.store.setSessionId(chatId, sessionId);
  }

  finish(chatId: number, status: RunningTask["status"]): void {
    const run = this.active.get(chatId);
    if (!run) return;
    this.store.updateTaskStatus(run.taskId, status, Date.now());
    this.active.delete(chatId);
  }

  stop(chatId: number): boolean {
    const run = this.active.get(chatId);
    if (!run) return false;
    run.abortController.abort();
    return true;
  }

  stopByTaskId(taskId: string): boolean {
    for (const run of this.active.values()) {
      if (run.taskId === taskId) {
        run.abortController.abort();
        return true;
      }
    }
    return false;
  }

  /** All currently active runs (for /tasks). */
  activeRuns(): ActiveRun[] {
    return [...this.active.values()];
  }

  // ---- queue (persisted in SQLite via Store) ----

  /** Enqueue a prompt; returns its 1-based position in the queue. Media buffers
   *  are written to temp files and only their paths persisted. */
  enqueue(chatId: number, item: QueueItem): number {
    const id = randomUUID();
    const mediaJson = persistMedia(id, item.prompt.media ?? [], this.opts.mediaDir ?? "");
    this.store.enqueueTask({
      id,
      chatId,
      projectPath: item.projectPath ?? null,
      prompt: item.prompt.text,
      displayText: item.displayText,
      media: mediaJson,
      origin: item.origin ?? "interactive",
      cronJobId: item.cronJobId ?? null,
      createdAt: Date.now(),
    });
    return this.store.queueLength(chatId);
  }

  /** Remove and return the head of the queue, or undefined if empty. Reads
   *  media buffers back from disk, then cleans up the temp files. */
  dequeue(chatId: number): Dequeued | undefined {
    const task = this.store.dequeueTask(chatId);
    if (!task) return undefined;
    const media = loadMedia(task.media, this.opts.mediaDir ?? "");
    if (task.media) removeMediaDir(task.id, this.opts.mediaDir ?? "");
    return {
      taskId: task.id,
      prompt: { text: task.prompt, ...(media ? { media } : {}) },
      displayText: task.displayText,
      projectPath: task.projectPath,
      origin: task.origin,
      cronJobId: task.cronJobId,
    };
  }

  queueLength(chatId: number): number {
    return this.store.queueLength(chatId);
  }

  /** Drop the entire queue; returns how many items were removed. */
  dropQueue(chatId: number): number {
    return this.store.dropQueue(chatId);
  }

  /** Snapshot of queued items (for /queue display). Does not mutate. */
  queuedItems(chatId: number): { displayText: string }[] {
    return this.store.queuedTasks(chatId).map((t) => ({ displayText: t.displayText }));
  }

  // ---- auto mode (in-memory, resets on restart) ----

  private autoChats = new Set<number>();

  setAuto(chatId: number, enabled: boolean): void {
    if (enabled) this.autoChats.add(chatId);
    else this.autoChats.delete(chatId);
  }

  isAuto(chatId: number): boolean {
    return this.autoChats.has(chatId);
  }

  // ---- context usage (in-memory, resets on restart) ----

  private contextUsage = new Map<number, number>();

  setContextUsage(chatId: number, pct: number): void {
    this.contextUsage.set(chatId, pct);
  }

  getContextUsage(chatId: number): number | undefined {
    return this.contextUsage.get(chatId);
  }

  clearContextUsage(chatId: number): void {
    this.contextUsage.delete(chatId);
  }
}
