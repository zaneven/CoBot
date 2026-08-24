# CoBot 项目 Agent 开发者与规范指南 (AGENTS.md)

欢迎使用并协同开发 **CoBot** 项目。本文档面向参与本项目代码阅读、架构设计、排错诊断及代码评审的 AI Agent 及人类开发者，旨在明确项目的技术栈架构、智能体角色分工、核心设计约束与开发规约。

---

## 1. 项目概览

**CoBot** 是一个使用 TypeScript (`tsx` + ESM) 编写的 Telegram Bot，通过 `@anthropic-ai/claude-agent-sdk` 驱动本地 Claude Code 实例，实现与本地工作区会话的交互、任务调度、多模态支持及自动化管理。

---

## 2. 项目专属 Agents (.claude/agents/)

本项目内置了 3 个专有 Agent 配置文件（位于 `.claude/agents/`），针对不同任务场景提供了定制化的 Prompt 与上下文约束：

| Agent 角色 | 配置文件 | 职责范围 |
| :--- | :--- | :--- |
| **Architect** | [cobot-architect.md](file:///.claude/agents/cobot-architect.md) | **架构设计与新功能规划**：负责新命令设计、队列/注册表模型演进、多模态支持与 SDK/Bot 边界重构。 |
| **Debugger** | [cobot-debug.md](file:///.claude/agents/cobot-debug.md) | **运行时故障诊断**：排查 Telegram ↔ CoBot ↔ Claude SDK 链路异常、代理超时与数据库状态。 |
| **Reviewer** | [cobot-review.md](file:///.claude/agents/cobot-review.md) | **代码评审与质量把控**：审查 PR/Diff，重点关注流式正确性、队列安全、代理/网络边角案、Telegram API 限频及测试覆盖率。 |

---

## 3. 技术栈 (Technology Stack)

| 视角/分层 | 技术选型 | 说明 |
| :--- | :--- | :--- |
| **Bot 框架** | `grammY` (1.30+) | 使用 Long-polling 机制。注意：底层为 `node-fetch`，需直接通过 `baseFetchConfig` 注入代理。 |
| **Agent SDK** | `@anthropic-ai/claude-agent-sdk` | 封装为 `runClaude` 异步生成器，通过 `query()` 进行流式推理与工具调用。 |
| **持久化存储** | `better-sqlite3` | 使用 WAL 模式，数据库文件位于 `data/cobot.db`，管理任务状态与 Cron 任务。 |
| **定时调度器** | `node-cron` | 由 `src/scheduler/cron.ts` 的 `CronManager` 统一调度与管理。 |
| **运行时** | Node.js (>=20) + `tsx` | 标准 ES Module (`type: "module"`)。 |
| **测试框架** | Node.js 内置 Test Runner | 命令 `node --import tsx --test <files...>`，禁止引入 vitest/jest 等外部框架。 |
| **日志组件** | `pino` + `pino-pretty` | 结构化 JSON/Pretty 日志输出。 |
| **网络代理** | `scutil` / ENV 自动检测 | 自动检测 macOS代理并生成 `HttpsProxyAgent` / `SocksProxyAgent`（端口 `127.0.0.1:10808`）。 |

---

## 4. 关键模块与源码结构

```
src/
├── bot/
│   ├── bot.ts           — grammY 初始化、中间件配置、权限拦截与命令路由
│   ├── commands.ts      — /command 响应逻辑、纯文本消息处理与键盘别名
│   ├── runs.ts          — runTurn / runOne / submitInteractive 任务处理与队列消耗循环
│   ├── streaming.ts     — TelegramStreamer（Rich Message 与 HTML 降级流式渲染）
│   ├── indicator.ts     — SilenceIndicator 心跳与状态提示（"Still working…"）
│   ├── media.ts         — handlePhoto / handleDocument 多模态附件解析
│   └── *.test.ts        — bot 模块单元测试
├── claude/
│   ├── driver.ts        — runClaude 异步生成器，对 SDK query() 的隔离封装
│   ├── sessions.ts      — SDK listSessions 接口封装
│   ├── types.ts         — DriverEvent、PromptInput、MediaAttachment 等核心类型定义
│   └── driver.test.ts   — SDK 驱动层测试
├── registry/
│   └── registry.ts      — 单 Chat FIFO 任务队列与活跃任务（active-run）追踪
├── store/
│   └── db.ts            — SQLite 数据库绑定、running_tasks 与 cron_jobs 表管理
├── scheduler/
│   └── cron.ts          — CronManager 定时任务注册、分发与中止管理
├── util/
│   ├── proxy.ts         — 代理环境检测与 Agent 实例化
│   ├── http.ts          — 带代理的 Buffer 下载工具
│   ├── send.ts          — Telegram 发送封装（带重试/代理的 sendMessage 等）
│   ├── tgfmt.ts         — Telegram HTML 转义与 Markdown 转换引擎
│   └── logger.ts        — Pino 日志封装
├── config.ts            — YAML 与环境变量配置加载器
└── index.ts             — 应用入口：初始化 Bot、装载 Cron 并启动长轮询
```

---

## 5. 核心设计原则与架构强约束

所有 AI Agent 或人类开发者在修改代码时，必须遵守以下核心约束：

### 1. SDK 严格隔离原则
- **`src/claude/driver.ts` 是 SDK 的唯一边界**。
- `src/bot/` 或 `src/registry/` 禁止直接 `import` 任何 `@anthropic-ai/claude-agent-sdk` 的类型或函数。
- Bot 层仅通过 `DriverEvent` 联合类型与 Driver 进行通信。若需增加交互状态，应在 `src/claude/types.ts` 中扩充 `DriverEvent` 变体。

### 2. 非阻塞（Fire-and-Forget）架构
- grammY 的 Long-polling 更新循环必须保持流畅，**绝对不能在 Update Handler 中直接 `await` 长时间运行的任务**（否则 `/stop` 等指令将被阻塞无法响应）。
- 提交任务必须使用 `void runOne(...)` 或 `submitInteractive` 非阻塞触发。

### 3. 单 Chat 任务队列与并发防护
- 每个 Chat 拥有独立的 FIFO 队列（由 `registry` 管理）。
- `submitInteractive` 在任务发起前检查 `registry.isActive()`，若当前已有活跃任务则入队。
- `registry.start()` 必须在 `await runTurn()` **之前同步调用**，确保无并发隙缝。任务完成后由 `drainQueued` 触发下一任务。

### 4. 流式 Markdown 渲染防护
- `TelegramStreamer` 有两级长度控制，注意区分：
  - **单条消息追加阈值** `maxEditChars`（默认 `3500`，由 `config.telegram.maxEditChars` 配置）：buffer 累积超过该值即 flush 成新消息并重置编辑目标。
  - **Telegram 硬上限分片** `TG_HARD_LIMIT = 32000`（`streaming.ts` 内常量）：单条消息超过 32768 字符上限时按 32000 分片发送。
- 节流限制：默认 `flushMs = 900ms`（由 `config.telegram.flushMs` 配置）串行节流，所有发送经 Promise 链串行化避免并发 edit 限频。
- 采用 **Rich Message 优先 + HTML 降级** 策略。中间态文本发送给 Telegram 解析前，必须通过 `sanitizeStreamMarkdown` 修复未闭合的代码块与行内标点。
- 详细渲染机制请参考文档：[docs/markdown_rendering.md](file:///docs/markdown_rendering.md)。

### 5. 无人值守权限管理 (Headless Permission)
- 由于无前端交互界面，Driver 默认设置 `canUseTool = () => ({ behavior: "allow" })` 自动批准工具调用，防止任务因等待交互权限而超时挂起。

### 6. 网络代理必传规则
- 本机对 `api.telegram.org` 的请求需通过代理（`127.0.0.1:10808`）。
- 任何新增的 HTTP/HTTPS 请求客户端（包括 grammY `baseFetchConfig`），均须传入 `src/util/proxy.ts` 生成的 Proxy Agent。

---

## 6. 开发与测试规约

1. **添加新命令**：
   - 在 `src/bot/commands.ts` 中编写命令处理逻辑。
   - 在 `src/bot/bot.ts` 中注册路由。
   - 如为用户侧核心功能，同步提供中文按键别名。
2. **编写与运行单元测试**：
   - 测试文件命名遵循 `src/<module>/<file>.test.ts`。
   - 在 `package.json` 的 `"test"` 脚本中注册新测试文件。
   - 运行测试指令：
     ```bash
     npm test
     ```
3. **类型检查**：
   - 提交前须运行：
     ```bash
     npm run typecheck
     ```

---

## 7. 服务控制与 CLI 管理 (Service Management)

本项目提供了统一的服务控制脚本 [scripts/cobot.sh](file:///scripts/cobot.sh) 及全局 `cobot` CLI 指令：

1. **环境依赖与 CLI 注册**：
   ```bash
   ./scripts/cobot.sh install
   ```
   该指令会自动复制配置文件模版、安装 npm 依赖、运行交互式配置（Telegram Token / 用户 ID / 开发根目录，默认取当前目录）、类型检查，注册全局 `cobot` CLI 软链接，**并在配置完成后自动启动 Bot 服务**。

2. **全局服务管理命令（可在系统任何目录下运行）**：
   - `cobot start` 或 `./scripts/cobot.sh start`：后台启动 Bot 服务，自动检测并注入代理（如 `127.0.0.1:10808`）。
   - `cobot stop` 或 `./scripts/cobot.sh stop`：平滑关闭进程并清理 SQLite 数据库中因中断残留的任务锁。
   - `cobot restart` 或 `./scripts/cobot.sh restart`：安全重启 Bot 服务。
   - `cobot status` 或 `./scripts/cobot.sh status`：查看服务 PID 状态、代理连通及 `bot.log` 运行日志。
   - `cobot uninstall` 或 `./scripts/cobot.sh uninstall`：停止服务并移除全局 `cobot` CLI 与 `node_modules`/`dist`/`data`/日志/`config.yaml`/`.env`（源码目录保留）。加 `--yes` 跳过确认提示。

---

## 8. 诊断与排错参考

遇到运行异常时，请按顺序检查：
1. **服务控制**：运行 `cobot status` 或 `cobot restart` 排查或重置服务状态。
2. **代理可用性**：`scutil --proxy` 确认 `127.0.0.1:10808` 代理正常开启。
3. **残留任务清理**：`sqlite3 data/cobot.db "SELECT * FROM running_tasks WHERE status='running'"`（确认是否有未清理的死锁任务）。
4. **日志分析**：查阅 `bot.log` 与 CoBot 控制台 pino 输出。
