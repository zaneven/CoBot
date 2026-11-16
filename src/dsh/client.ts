import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { existsSync } from "node:fs";
import type {
  AcpInitializeResult,
  AcpConfigOption,
  AcpPermissionRequest,
  AcpPermissionResult,
  AcpSessionListResult,
  AcpSessionResult,
  AcpSessionUpdate,
} from "./types.js";
import { logger } from "../util/logger.js";

/**
 * Long-lived ACP client for the DeepSeek Harness (`dsh --profile acp`).
 *
 * `dsh` boots in ~1–1.5 s and pulling its model catalog costs another ~2.5 s on
 * the first `session/new`, so the process is kept resident for the bot's
 * lifetime and shared by every chat: ACP sessions carry their own `cwd`, so one
 * runtime serves all projects (verified against 0.2.2-rc.1).
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (stdout is protocol-only,
 * diagnostics go to stderr). Server→client requests such as
 * `session/request_permission` are answered by the `onPermissionRequest`
 * callback; everything else is a notification fanned out per session.
 */
export class DshAcpClient {
  private child?: ChildProcess;
  private rl?: Interface;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private updateListeners = new Map<string, Set<(u: AcpSessionUpdate) => void>>();
  private booting?: Promise<AcpInitializeResult>;
  private initialised = false;
  private closed = false;
  private stderrTail = "";
  /** Model routes advertised by the last `session/new` / `config_option_update`. */
  private lastOptions: AcpConfigOption[] | undefined;

  constructor(
    private opts: {
      executable?: string;
      /** Launch environment for the runtime (proxy vars + DSH_PERMISSION_MODE). */
      env?: NodeJS.ProcessEnv;
      requestTimeoutMs?: number;
    } = {},
  ) {}

  resolveExecutable(): string {
    const explicit = this.opts.executable;
    if (explicit && existsSync(explicit)) return explicit;
    const envPath = process.env.DSH_PATH;
    if (envPath && existsSync(envPath)) return envPath;
    for (const p of ["/opt/homebrew/bin/dsh", "/usr/local/bin/dsh", "/usr/bin/dsh"]) {
      if (existsSync(p)) return p;
    }
    return "dsh";
  }

  /** Health/runtime info from `initialize` (spawns the runtime on first call). */
  async init(): Promise<AcpInitializeResult> {
    return this.boot();
  }

  /** Last advertised config options (model catalog + reasoning effort). */
  configOptions(): AcpConfigOption[] {
    return this.lastOptions ?? [];
  }

  private boot(): Promise<AcpInitializeResult> {
    if (this.booting) return this.booting;
    this.booting = (async () => {
      await this.spawnChild();
      const res = await this.request<AcpInitializeResult>("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }, { sessionHint: undefined });
      this.initialised = true;
      logger.info({ agent: res.agentInfo, capabilities: res.agentCapabilities }, "dsh acp runtime initialised");
      return res;
    })().catch((err) => {
      this.booting = undefined;
      throw err;
    });
    return this.booting;
  }

  private async spawnChild(): Promise<void> {
    const executable = this.resolveExecutable();
    const env: NodeJS.ProcessEnv = {
      ...(this.opts.env ?? process.env),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };
    logger.info({ executable }, "spawning dsh --profile acp");
    const child = spawn(executable, ["--profile", "acp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        child.off("spawn", onSpawn);
        reject(new Error(`failed to spawn dsh (${executable}): ${err.message}`));
      };
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });

    if (!child.stdout || !child.stdin) {
      throw new Error("dsh acp runtime has no stdio pipes");
    }
    this.rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.handleLine(line));
    if (child.stderr) {
      const rlErr = createInterface({ input: child.stderr, crlfDelay: Infinity });
      rlErr.on("line", (line) => {
        const t = line.trim();
        if (!t || t.includes("UNDICI-EHPA") || t.includes("trace-warnings")) return;
        this.stderrTail = `${this.stderrTail}${this.stderrTail ? "\n" : ""}${t}`.slice(-600);
        logger.debug({ dshStderr: t }, "dsh stderr");
      });
    }
    child.on("close", (code, signal) => {
      const wasClosedByUs = this.closed;
      this.closed = true;
      this.child = undefined;
      this.booting = undefined;
      this.initialised = false;
      const err = new Error(
        `dsh acp runtime exited (${signal ?? code})${this.stderrTail ? `: ${this.stderrTail.split("\n").pop()}` : ""}`,
      );
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      if (!wasClosedByUs) logger.warn({ code, signal, stderr: this.stderrTail.slice(-200) }, "dsh acp runtime exited unexpectedly");
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      logger.debug({ dshLine: trimmed.slice(0, 200) }, "dsh non-JSON stdout line");
      return;
    }
    const id = msg.id;
    const method = msg.method;
    // Response: id only.
    if (id !== undefined && typeof method !== "string") {
      const numId = typeof id === "number" ? id : Number(id);
      const p = this.pending.get(numId);
      if (!p) return;
      this.pending.delete(numId);
      if (p.timer) clearTimeout(p.timer);
      const error = msg.error as { code?: number; message?: string } | undefined;
      if (error) p.reject(new Error(error.message ?? `dsh error ${error.code ?? "?"}`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof method !== "string") return;
    // Server→client request (id + method) — must be answered.
    if (id !== undefined) {
      void this.answerServerRequest(id, method, msg.params);
      return;
    }
    // Notification.
    if (method === "session/update") {
      const params = msg.params as { sessionId?: string; update?: AcpSessionUpdate } | undefined;
      if (params?.sessionId && params.update) {
        const u = params.update as { sessionUpdate: string; configOptions?: AcpConfigOption[] };
        if (u.sessionUpdate === "config_option_update" && u.configOptions) {
          this.lastOptions = u.configOptions;
        }
        for (const fn of this.updateListeners.get(params.sessionId) ?? []) fn(params.update);
      }
      return;
    }
    logger.debug({ method }, "dsh notification");
  }

  private answerServerRequest(id: unknown, method: string, paramsRaw: unknown): void {
    const params = paramsRaw as AcpPermissionRequest | undefined;
    const respond = (result: unknown) => this.write({ jsonrpc: "2.0", id, result });
    if (method.endsWith("session/request_permission")) {
      const req = params ?? {};
      const handler = this.onPermissionRequest;
      if (!handler) {
        respond({ outcome: { outcome: "cancelled" } } satisfies AcpPermissionResult);
        return;
      }
      handler(req)
        .then((res) => respond(res))
        .catch((err) => {
          logger.warn({ err: String(err) }, "permission handler failed; rejecting once");
          respond({ outcome: { outcome: "selected", optionId: "reject-once" } } satisfies AcpPermissionResult);
        });
      return;
    }
    // Unknown server request: answer with a JSON-RPC error so the runtime
    // doesn't park the turn forever waiting on us.
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported server request: ${method}` } });
  }

  /** Handler for ACP permission prompts (wired by the bot's approval bridge). */
  onPermissionRequest?: (req: AcpPermissionRequest) => Promise<AcpPermissionResult>;

  private permissionHandlers = new Map<string, PermissionHandler>();

  /**
   * Register a per-session permission handler. Several chats share one runtime,
   * so the dispatcher keys on the session id and falls back to the latest
   * registered handler when the request names none. Returns a disposer.
   */
  registerPermissionHandler(sessionId: string, handler: PermissionHandler): () => void {
    this.permissionHandlers.set(sessionId, handler);
    this.onPermissionRequest = (req) => {
      const sid = req.sessionId ?? "";
      const h = this.permissionHandlers.get(sid) ?? handler;
      return h(req);
    };
    return () => {
      this.permissionHandlers.delete(sessionId);
      if (this.permissionHandlers.size === 0) this.onPermissionRequest = undefined;
    };
  }


  private write(msg: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private request<T>(method: string, params: unknown, opts: { sessionHint?: string; timeoutMs?: number }): Promise<T> {
    if (!this.child?.stdin) return Promise.reject(new Error("dsh acp runtime is not running"));
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!this.pending.has(id)) return;
              this.pending.delete(id);
              reject(new Error(`dsh ${method} timed out after ${timeoutMs}ms${opts.sessionHint ? ` (session ${opts.sessionHint})` : ""}`));
            }, timeoutMs)
          : undefined;
      if (timer) timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Spawn + initialise on demand, so callers never race the boot. */
  private async ensureReady(): Promise<void> {
    if (this.initialised && this.child) return;
    if (this.closed) {
      // A previous runtime died; start a fresh one.
      this.closed = false;
      this.booting = undefined;
    }
    await this.boot();
  }

  /** Register an update listener for one session id. Returns a disposer. */
  onUpdate(sessionId: string, fn: (u: AcpSessionUpdate) => void): () => void {
    let set = this.updateListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.updateListeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      const cur = this.updateListeners.get(sessionId);
      if (!cur) return;
      cur.delete(fn);
      if (cur.size === 0) this.updateListeners.delete(sessionId);
    };
  }

  async newSession(cwd: string): Promise<AcpSessionResult> {
    await this.ensureReady();
    const res = await this.request<AcpSessionResult>("session/new", { cwd, mcpServers: [] }, { timeoutMs: 120_000 });
    if (res.configOptions) this.lastOptions = res.configOptions;
    return res;
  }

  async resumeSession(sessionId: string, cwd: string): Promise<AcpSessionResult> {
    await this.ensureReady();
    const res = await this.request<AcpSessionResult>("session/resume", { sessionId, cwd }, { timeoutMs: 120_000 });
    if (res.configOptions) this.lastOptions = res.configOptions;
    return res;
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request<Record<string, never>>("session/close", { sessionId }, { timeoutMs: 15_000 }).catch((err) => {
      logger.debug({ err: String(err), sessionId }, "session/close failed (runtime may have already dropped it)");
    });
  }

  async setModel(sessionId: string, value: string): Promise<AcpSessionResult> {
    await this.ensureReady();
    const res = await this.request<AcpSessionResult>(
      "session/set_config_option",
      { sessionId, configId: "model", value },
      { timeoutMs: 60_000 },
    );
    if (res.configOptions) this.lastOptions = res.configOptions;
    return res;
  }

  async setReasoningEffort(sessionId: string, effort: string): Promise<AcpSessionResult> {
    await this.ensureReady();
    const res = await this.request<AcpSessionResult>(
      "session/set_config_option",
      { sessionId, configId: "reasoning_effort", value: effort },
      { timeoutMs: 60_000 },
    );
    if (res.configOptions) this.lastOptions = res.configOptions;
    return res;
  }

  /** Submit one prompt. Resolves when the turn settles (stopReason). */
  async prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<{ stopReason?: string }> {
    await this.ensureReady();
    const onAbort = () => this.cancel(sessionId);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.request<{ stopReason?: string }>(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text }] },
        { sessionHint: sessionId, timeoutMs: 0 }, // turn length is bounded by the driver watchdog
      );
    } catch (err) {
      if (signal?.aborted) return { stopReason: "cancelled" };
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** ACP cancellation is a notification (no response). */
  cancel(sessionId: string): void {
    this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  async listSessions(cwd?: string): Promise<AcpSessionListResult> {
    await this.ensureReady();
    const params: Record<string, unknown> = {};
    if (cwd) params.cwd = cwd;
    return this.request<AcpSessionListResult>("session/list", params, { timeoutMs: 30_000 });
  }

  /** Shut the runtime down (bot exit). Best-effort. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (child && !child.killed) {
      try {
        child.stdin?.end();
        child.kill("SIGTERM");
      } catch {
        /* best effort */
      }
    }
  }
}

/** A per-session ACP permission answerer (see registerPermissionHandler). */
export type PermissionHandler = (req: AcpPermissionRequest) => Promise<AcpPermissionResult>;

/** Process-wide client shared by every dsh run (the runtime serves all chats). */
let shared: DshAcpClient | undefined;

export function getSharedDshClient(opts: { executable?: string; env?: NodeJS.ProcessEnv } = {}): DshAcpClient {
  if (!shared) shared = new DshAcpClient(opts);
  return shared;
}

export function resetSharedDshClient(): void {
  shared = undefined;
}
