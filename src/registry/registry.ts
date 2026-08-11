import { randomUUID } from "node:crypto";
import type { Store, RunningTask } from "../store/db.js";
import type { PromptInput } from "../claude/types.js";

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

/** A prompt waiting in a chat's queue to run once the active task finishes. */
export interface QueueItem {
  prompt: PromptInput;
  displayText: string;
  onSessionId?: (id: string) => void;
}

/**
 * Tracks the currently-running Claude Code task per Telegram chat plus a FIFO
 * queue of pending prompts. One active task per chat; further prompts enqueue
 * and drain when the active task finishes. The queue is in-memory only - a
 * process restart drops pending items (the active task is swept to 'aborted' by
 * Store.sweepStaleRunning at startup).
 */
export class Registry {
  private active = new Map<number, ActiveRun>();
  private queues = new Map<number, QueueItem[]>();

  constructor(private store: Store) {}

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

  // ---- queue ----

  /** Enqueue a prompt; returns its 1-based position in the queue. */
  enqueue(chatId: number, item: QueueItem): number {
    const q = this.queues.get(chatId) ?? [];
    q.push(item);
    this.queues.set(chatId, q);
    return q.length;
  }

  /** Remove and return the head of the queue, or undefined if empty. */
  dequeue(chatId: number): QueueItem | undefined {
    const q = this.queues.get(chatId);
    if (!q || q.length === 0) return undefined;
    const item = q.shift()!;
    if (q.length === 0) this.queues.delete(chatId);
    return item;
  }

  queueLength(chatId: number): number {
    return this.queues.get(chatId)?.length ?? 0;
  }

  /** Drop the entire queue; returns how many items were removed. */
  dropQueue(chatId: number): number {
    const q = this.queues.get(chatId);
    if (!q) return 0;
    const n = q.length;
    this.queues.delete(chatId);
    return n;
  }

  /** Snapshot of queued items (for /queue display). Does not mutate. */
  queuedItems(chatId: number): QueueItem[] {
    return [...(this.queues.get(chatId) ?? [])];
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
