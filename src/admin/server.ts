import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig, saveYamlConfig, readRawYamlContent, listDevProjects, type Config, type YamlConfig } from "../config.js";
import type { Store } from "../store/db.js";
import type { Registry } from "../registry/registry.js";
import type { CronManager } from "../scheduler/cron.js";
import { logger, getLogLevel, setLogLevel } from "../util/logger.js";

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

// In-memory log buffer for live console streaming
const LOG_BUFFER_MAX = 500;
const logBuffer: string[] = [];
const sseClients = new Set<ServerResponse>();

export function appendAdminLog(msg: string): void {
  logBuffer.push(msg);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  for (const res of sseClients) {
    res.write(`data: ${JSON.stringify({ log: msg })}\n\n`);
  }
}

export class AdminServer {
  private server: Server | null = null;
  private startTime = Date.now();

  constructor(
    private config: Config,
    private store: Store,
    private registry: Registry,
    private cronManager?: CronManager,
    private configPath = resolve(process.cwd(), "config.yaml"),
  ) {}

  private sseTokens = new Map<string, number>();
  private rateLimits = new Map<string, { count: number; resetAt: number; failedAttempts: number; bannedUntil: number }>();

  private getClientIp(req: IncomingMessage): string {
    const xForwardedFor = req.headers["x-forwarded-for"];
    if (typeof xForwardedFor === "string" && xForwardedFor.trim() !== "") {
      return (xForwardedFor.split(",")[0] || "").trim() || "127.0.0.1";
    }
    return req.socket.remoteAddress || "127.0.0.1";
  }

  private checkRateLimit(ip: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    let entry = this.rateLimits.get(ip);
    if (!entry) {
      entry = { count: 0, resetAt: now + 60_000, failedAttempts: 0, bannedUntil: 0 };
      this.rateLimits.set(ip, entry);
    }

    if (entry.bannedUntil > now) {
      return { allowed: false, reason: "IP temporarily banned due to repeated auth failures" };
    }

    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + 60_000;
    }

    entry.count += 1;
    if (entry.count > 300) {
      return { allowed: false, reason: "Too Many Requests: Rate limit exceeded (300 req/min/IP)" };
    }

    return { allowed: true };
  }

  private recordAuthFailure(ip: string): void {
    const now = Date.now();
    let entry = this.rateLimits.get(ip);
    if (!entry) {
      entry = { count: 1, resetAt: now + 60_000, failedAttempts: 0, bannedUntil: 0 };
      this.rateLimits.set(ip, entry);
    }
    entry.failedAttempts += 1;
    if (entry.failedAttempts >= 5) {
      entry.bannedUntil = now + 15 * 60 * 1000;
    }
  }

  private recordAuthSuccess(ip: string): void {
    const entry = this.rateLimits.get(ip);
    if (entry) {
      entry.failedAttempts = 0;
    }
  }

  createSseToken(): string {
    const token = randomBytes(16).toString("hex");
    this.sseTokens.set(token, Date.now() + 60_000);
    return token;
  }

  validateAndConsumeSseToken(token: string): boolean {
    const expiresAt = this.sseTokens.get(token);
    if (!expiresAt) return false;
    this.sseTokens.delete(token);
    return Date.now() <= expiresAt;
  }

  getPort(): number {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") return addr.port;
    return this.config.admin.port;
  }

  async start(): Promise<void> {
    if (!this.config.admin.enabled) {
      logger.info("Admin Web Server is disabled by config.");
      return;
    }

    if (!this.config.admin.apiKey && this.config.admin.authEnabled !== false) {
      logger.warn("COBOT_ADMIN_API_KEY is not set; Admin Web Server will not start.");
      return;
    }

    const port = this.config.admin.port;
    const host = this.config.admin.host;

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        if (err instanceof HttpError) {
          if (!res.headersSent) {
            res.writeHead(err.statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }
        logger.error({ err: String(err) }, "Admin HTTP handler uncaught error");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        }
      });
    });

    return new Promise((resolve) => {
      this.server!.listen(port, host, () => {
        logger.info({ port: this.getPort(), host, apiKeySet: !!this.config.admin.apiKey }, "Admin Web Server started");
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      for (const client of sseClients) {
        client.end();
      }
      sseClients.clear();
      this.sseTokens.clear();
      this.rateLimits.clear();
      this.server.close();
      this.server = null;
      logger.info("Admin Web Server stopped");
    }
  }

  private authenticate(req: IncomingMessage): boolean {
    // Open mode: auth disabled via config — allow all requests.
    if (this.config.admin.authEnabled === false) return true;

    const expectedKey = this.config.admin.apiKey;
    if (!expectedKey) return false;

    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      if (authHeader.slice(7) === expectedKey) return true;
    }

    const customKey = req.headers["x-admin-api-key"];
    if (customKey === expectedKey) return true;

    return false;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Serve Static Dashboard SPA (HTML)
    if (pathname === "/" || pathname === "/index.html") {
      return this.serveStaticHtml(res);
    }

    // Require Auth and Rate Limit for API Endpoints
    if (pathname.startsWith("/admin/api/")) {
      if (pathname === "/admin/api/auth-status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ authEnabled: this.config.admin.authEnabled }));
        return;
      }

      const clientIp = this.getClientIp(req);
      const rateCheck = this.checkRateLimit(clientIp);
      if (!rateCheck.allowed) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: rateCheck.reason }));
        return;
      }

      if (pathname === "/admin/api/logs/stream") {
        const token = url.searchParams.get("token");
        if (!token || !this.validateAndConsumeSseToken(token)) {
          this.recordAuthFailure(clientIp);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid or expired SSE token" }));
          return;
        }
        this.recordAuthSuccess(clientIp);
      } else {
        if (!this.authenticate(req)) {
          this.recordAuthFailure(clientIp);
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin API Key" }));
          return;
        }
        this.recordAuthSuccess(clientIp);
      }

      return this.handleApi(req, res, pathname, url);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const json = (data: unknown, statusCode = 200) => {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    // 1. System Status
    if (pathname === "/admin/api/status" && req.method === "GET") {
      const activeRuns = this.registry.activeRuns();
      return json({
        status: "ok",
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
        pid: process.pid,
        nodeVersion: process.version,
        proxyEnv: process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "http://127.0.0.1:10808",
        activeTaskCount: activeRuns.length,
        memoryUsage: process.memoryUsage(),
        config: {
          permissionMode: this.config.claude.permissionMode,
          allowDangerousSkip: this.config.claude.allowDangerousSkip,
          taskTimeoutMs: this.config.claude.taskTimeoutMs,
          maxTurns: this.config.claude.maxTurns,
          projectsCount: this.config.projects.length,
          devRoots: this.config.devRoots,
        },
      });
    }

    // 2. Dashboard Audit Statistics
    if (pathname === "/admin/api/stats" && req.method === "GET") {
      const since = Number(url.searchParams.get("since") || "0");
      const stats = this.store.getAuditStats(since);
      return json(stats);
    }

    // 3. Running & Queued Tasks
    if (pathname === "/admin/api/tasks" && req.method === "GET") {
      const activeRuns = this.registry.activeRuns().map((r) => ({
        taskId: r.taskId,
        chatId: r.chatId,
        projectPath: r.projectPath,
        startedAt: r.startedAt,
        sessionId: r.sessionId || null,
        displayText: r.displayText,
        queueLength: this.registry.queueLength(r.chatId),
      }));
      return json({ activeTasks: activeRuns });
    }

    // 4. Abort Running Task
    if (pathname === "/admin/api/tasks/abort" && req.method === "POST") {
      const body = await this.readJsonBody<{ taskId?: string; chatId?: number }>(req);
      let stopped = false;
      if (body.taskId) {
        stopped = this.registry.stopByTaskId(body.taskId);
      } else if (body.chatId) {
        stopped = this.registry.stop(body.chatId);
      }
      return json({ success: stopped, message: stopped ? "Task aborted" : "Task not found or already finished" });
    }

    // 5. Historical Audit Logs (Paginated)
    if (pathname === "/admin/api/audit" && req.method === "GET") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || "50")));
      const offset = Math.max(0, Number(url.searchParams.get("offset") || "0"));
      const result = this.store.listAllAuditLogs(limit, offset);
      return json(result);
    }

    // 6. Cron Jobs List & Operations
    if (pathname === "/admin/api/cron" && req.method === "GET") {
      const crons = this.store.listAllCron();
      return json({ cronJobs: crons });
    }

    if (pathname === "/admin/api/cron/toggle" && req.method === "POST") {
      const body = await this.readJsonBody<{ id: string; enabled: boolean }>(req);
      if (!body.id) return json({ error: "Missing cron id" }, 400);
      if (this.cronManager) {
        if (body.enabled) {
          this.cronManager.enable(body.id);
        } else {
          this.cronManager.disable(body.id);
        }
      } else {
        this.store.setCronEnabled(body.id, body.enabled ? 1 : 0);
      }
      return json({ success: true });
    }

    if (pathname === "/admin/api/cron/delete" && req.method === "POST") {
      const body = await this.readJsonBody<{ id: string; chatId: number }>(req);
      if (!body.id || !body.chatId) return json({ error: "Missing id or chatId" }, 400);
      let deleted = false;
      if (this.cronManager) {
        deleted = this.cronManager.remove(body.chatId, body.id);
      } else {
        deleted = this.store.deleteCron(body.chatId, body.id);
      }
      return json({ success: deleted });
    }

    // 7. Bindings & Dev Roots
    if (pathname === "/admin/api/bindings" && req.method === "GET") {
      const bindings = this.store.listAllBindings();
      return json({
        bindings,
        projects: this.config.projects,
        devRoots: this.config.devRoots,
        devProjects: listDevProjects(this.config),
      });
    }

    if (pathname === "/admin/api/bindings" && req.method === "POST") {
      const body = await this.readJsonBody<{ chatId: number; projectPath: string }>(req);
      if (!body.chatId || !body.projectPath) {
        return json({ error: "Missing chatId or projectPath" }, 400);
      }
      this.store.upsertBinding(body.chatId, body.projectPath);
      return json({ success: true });
    }

    if (pathname === "/admin/api/bindings" && req.method === "DELETE") {
      const body = await this.readJsonBody<{ chatId: number }>(req);
      if (!body.chatId) {
        return json({ error: "Missing chatId" }, 400);
      }
      this.store.clearBinding(body.chatId);
      return json({ success: true });
    }

    // 8. Online Config Management
    if (pathname === "/admin/api/config" && req.method === "GET") {
      return json({
        config: this.config,
        rawYaml: readRawYamlContent(this.configPath),
        devProjects: listDevProjects(this.config),
      });
    }

    if (pathname === "/admin/api/config" && req.method === "POST") {
      const updates = await this.readJsonBody<Partial<YamlConfig>>(req);
      saveYamlConfig(updates, this.configPath);
      // Hot-reload memory config
      this.config = loadConfig(this.configPath);
      return json({ success: true, config: this.config, rawYaml: readRawYamlContent(this.configPath) });
    }

    if (pathname === "/admin/api/dev-projects" && req.method === "GET") {
      return json({ devProjects: listDevProjects(this.config) });
    }

    // 8. Approval Rules (Tool Whitelist)
    if (pathname === "/admin/api/approval-rules" && req.method === "GET") {
      const rules = this.store.listAllApprovalRules();
      return json({ rules, defaultSkipTools: this.config.claude.approval?.skipTools || [] });
    }

    if (pathname === "/admin/api/approval-rules" && req.method === "DELETE") {
      const body = await this.readJsonBody<{ chatId: number; toolName?: string }>(req);
      if (!body.chatId) return json({ error: "Missing chatId" }, 400);
      const deletedCount = this.store.clearAlwaysAllow(body.chatId, body.toolName);
      return json({ success: true, deletedCount });
    }

    // 9. Multi-dimensional Analytics & Audit Detail (Phase 2)
    if (pathname === "/admin/api/analytics/daily" && req.method === "GET") {
      const days = Number(url.searchParams.get("days") || "7");
      const dailyData = this.store.getDailyAnalytics(days);
      return json({ daily: dailyData });
    }

    if (pathname === "/admin/api/analytics/tools" && req.method === "GET") {
      const toolDistribution = this.store.getToolUsageDistribution();
      return json({ tools: toolDistribution });
    }

    if (pathname === "/admin/api/audit/detail" && req.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "Missing audit id" }, 400);
      const audit = this.store.getAuditLogById(id);
      if (!audit) return json({ error: "Audit log not found" }, 404);
      return json({ audit });
    }

    // 10. Dynamic Log Level Management
    if (pathname === "/admin/api/log-level" && req.method === "GET") {
      return json({ level: getLogLevel() });
    }

    if (pathname === "/admin/api/log-level" && req.method === "POST") {
      const body = await this.readJsonBody<{ level: string }>(req);
      if (!body.level) return json({ error: "Missing level parameter" }, 400);
      const success = setLogLevel(body.level);
      if (success) {
        logger.info({ newLevel: body.level }, "Admin changed global log level");
        return json({ success: true, level: getLogLevel() });
      }
      return json({ error: "Invalid log level" }, 400);
    }

    // 11. SSE Log Stream Endpoint
    if (pathname === "/admin/api/logs/stream" && req.method === "GET") {
      const filterStr = url.searchParams.get("filter") || "";
      const levelFilter = url.searchParams.get("level") || "";

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      } else {
        res.write("\n");
      }

      const matches = (log: string): boolean => {
        if (levelFilter && !log.toLowerCase().includes(levelFilter.toLowerCase())) return false;
        if (filterStr && !log.toLowerCase().includes(filterStr.toLowerCase())) return false;
        return true;
      };

      // Send recent buffered logs first
      for (const log of logBuffer) {
        if (matches(log)) {
          res.write(`data: ${JSON.stringify({ log })}\n\n`);
        }
      }

      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    // 12. Short-lived Log Stream Token Endpoint
    if (pathname === "/admin/api/logs/token" && req.method === "POST") {
      const token = this.createSseToken();
      return json({ token });
    }

    json({ error: "API Endpoint Not Found" }, 404);
  }

  private readJsonBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      if (req.method === "POST") {
        const contentType = req.headers["content-type"] || "";
        if (!contentType.includes("application/json")) {
          reject(new HttpError(415, "Unsupported Media Type: Content-Type must be application/json"));
          return;
        }
      }

      let bytesRead = 0;
      let aborted = false;
      const chunks: Buffer[] = [];
      const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB

      req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        bytesRead += chunk.length;
        if (bytesRead > MAX_BODY_SIZE) {
          aborted = true;
          req.pause();
          reject(new HttpError(413, "Payload Too Large: Limit is 1MB"));
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (aborted) return;
        const body = Buffer.concat(chunks).toString("utf8");
        if (!body || body.trim() === "") {
          resolve({} as T);
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new HttpError(400, "Invalid JSON body"));
        }
      });

      req.on("error", (err) => {
        if (!aborted) reject(err);
      });
    });
  }

  private serveStaticHtml(res: ServerResponse): void {
    const htmlPath = resolve(process.cwd(), "src/admin/web/index.html");
    if (existsSync(htmlPath)) {
      const content = readFileSync(htmlPath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>CoBot Admin</h1><p>Admin web bundle loading error.</p>");
    }
  }
}
