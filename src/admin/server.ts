import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, saveYamlConfig, readRawYamlContent, listDevProjects, type Config, type YamlConfig } from "../config.js";
import type { Store } from "../store/db.js";
import type { Registry } from "../registry/registry.js";
import type { CronManager } from "../scheduler/cron.js";
import { logger } from "../util/logger.js";

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

  start(): void {
    if (!this.config.admin.enabled) {
      logger.info("Admin Web Server is disabled by config.");
      return;
    }

    const port = this.config.admin.port;

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err: String(err) }, "Admin HTTP handler uncaught error");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        }
      });
    });

    this.server.listen(port, () => {
      logger.info({ port, apiKeySet: !!this.config.admin.apiKey }, "Admin Web Server started");
    });
  }

  stop(): void {
    if (this.server) {
      for (const client of sseClients) {
        client.end();
      }
      sseClients.clear();
      this.server.close();
      this.server = null;
      logger.info("Admin Web Server stopped");
    }
  }

  private authenticate(req: IncomingMessage): boolean {
    const expectedKey = this.config.admin.apiKey;
    if (!expectedKey) return true; // No API key configured

    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      if (authHeader.slice(7) === expectedKey) return true;
    }

    const customKey = req.headers["x-admin-api-key"];
    if (customKey === expectedKey) return true;

    // Check query string ?apiKey=...
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.searchParams.get("apiKey") === expectedKey) return true;

    return false;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // CORS Headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Api-Key");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Serve Static Dashboard SPA (HTML)
    if (pathname === "/" || pathname === "/index.html") {
      return this.serveStaticHtml(res);
    }

    // Require Auth for API Endpoints
    if (pathname.startsWith("/admin/api/")) {
      if (!this.authenticate(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin API Key" }));
        return;
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

    // 9. SSE Log Stream Endpoint
    if (pathname === "/admin/api/logs/stream" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Send recent buffered logs first
      for (const log of logBuffer) {
        res.write(`data: ${JSON.stringify({ log })}\n\n`);
      }

      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    json({ error: "API Endpoint Not Found" }, 404);
  }

  private readJsonBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : ({} as T));
        } catch (e) {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
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
