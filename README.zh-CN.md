<p align="center">
  <a href="./README.md">English</a> &nbsp;|&nbsp; <b>中文</b>
</p>

<p align="center">
  <img alt="CoBot" width="120" src="https://raw.githubusercontent.com/zaneven/CoBot/main/docs/assets/logo.svg">
</p>

<h1 align="center">CoBot</h1>

<p align="center">
  在 Telegram 里驱动你本地的 <strong>Claude Code</strong>。<br/>
  一个自托管的 TypeScript 机器人，把 Telegram 会话桥接到本地正在运行的 Claude Code —— 流式回复、定时任务、多模态输入，外加一个内置管理控制台。
</p>

<p align="center">
  <a href="https://zaneven.github.io/CoBot/">落地页</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="./docs/">文档</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#开源协议">开源协议</a>
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-E8A33D?style=flat-square">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D20-5FD38A?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Claude Agent SDK" src="https://img.shields.io/badge/Claude%20Agent%20SDK-D97757?style=flat-square">
  <img alt="Telegram" src="https://img.shields.io/badge/Telegram-grammY-26A5E4?style=flat-square&logo=telegram&logoColor=white">
  <img alt="Tests" src="https://img.shields.io/badge/tests-226%20passing-5FD38A?style=flat-square">
</p>

---

## ✨ 为什么是 CoBot

Claude Code 是很强的 Agent 编程工具——但它活在你的终端里。**CoBot 把它装进你的口袋：** 从任何手机发一条 Telegram 消息，Claude Code 就在你指定的项目目录里启动（或恢复）会话，并把工作过程流式回传到聊天里。完全自托管，代码不离开你的机器，并自带一个拥有本地代码执行能力的 Agent 所必需的护栏。

**核心亮点**

- 📱 **从 Telegram 和 Claude Code 对话** —— 任何设备、任何地点
- 🌊 **流式 Markdown 回复**（表格、代码块、LaTeX），渐进式 Rich Message 编辑，HTML→纯文本降级
- 🗂️ **多项目会话** —— 在聊天里切换项目、恢复会话
- ⏰ **定时任务** —— "每天早上跑一遍测试套件并报告"
- 🖼️ **多模态输入** —— 发图片、PDF、日志文件配合你的提示
- 🛡️ **护栏** —— 单任务轮次上限、每日成本/Token 配额、审计日志、交互式工具审批
- 🖥️ **内置 Web 管理控制台** —— 实时任务、成本、工具用量、日志、配置
- 🔒 **自托管** —— 代码留在你机器上，用户白名单管控访问

---

## 📋 目录

- [快速开始](#快速开始)
- [工作原理](#工作原理)
- [功能特性](#功能特性)
- [命令一览](#命令一览)
- [配置](#配置)
- [安全与护栏](#安全与护栏)
- [Web 管理控制台](#web-管理控制台)
- [开发](#开发)
- [常见问题](#常见问题)
- [参与贡献](#参与贡献)
- [开源协议](#开源协议)

---

## 快速开始

### 前置条件

| 需要 | 怎么拿 |
| :--- | :--- |
| **Node.js ≥ 20** | <https://nodejs.org> |
| **本地已安装并登录的 Claude Code** | 本机必须能跑 `claude` CLI——CoBot 通过 Agent SDK 驱动它 |
| **Telegram 机器人 Token** | 用 [@BotFather](https://t.me/BotFather) 创建机器人 |
| **你的 Telegram 用户 ID** | [@userinfobot](https://t.me/userinfobot) 会告诉你 |

> ℹ️ CoBot 驱动的是机器**本地**的 Claude Code，它不直接调用 Anthropic API——所以宿主机上必须已安装并登录 Claude Code。

### 1 · 安装

```bash
git clone https://github.com/zaneven/CoBot.git
cd CoBot
./scripts/cobot.sh install
# 复制配置模板 · 安装依赖 · 重编译 SQLite 原生模块 · 注册全局 `cobot` CLI
```

<details>
<summary>手动安装</summary>

```bash
cp .env.example .env
cp config.example.yaml config.yaml
npm install
npm rebuild better-sqlite3   # 仅当 Node 版本变更时需要
```
</details>

### 2 · 配置

`.env` —— 机器人 Token + 谁能控制它：

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhi...
TELEGRAM_ALLOWED_USERS=100123456       # 你的 Telegram 用户 ID（逗号分隔）
```

`config.yaml` —— 白名单允许 CoBot 操作的目录：

```yaml
devRoots:
  - /Users/YOU/Develop          # 其直接子目录即为可切换的项目

telegram:
  allowedUsers: [100123456]    # 也可只写 .env

admin:
  enabled: true                # 内置 Web 管理控制台
  port: 8085
  apiKey: "选一个密钥"          # 管理 API 的 bearer token
```

### 3 · 启动

```bash
cobot start     # 后台服务，自动探测代理
cobot status    # 进程、代理、最近日志
```

前台/开发模式：`npm run dev`（保存即热重载）。

### 4 · 发第一条消息

1. 打开 Telegram，给机器人发消息。
2. `/projects` → 点选一个项目。
3. 直接发文本——Claude Code 就会回复，并**流式**进聊天。

> 🖼️ **征集截图：** 一张流式回复的截图/GIF 在这里最能让项目打动人。放到 `docs/assets/demo.png` 替换这段说明即可。

---

## 工作原理

```
                      Telegram（长轮询）
                              │
                              ▼
                 ┌────────────────────────┐
                 │   grammY 机器人         │
                 │   鉴权网关（白名单）    │
                 └────────────┬───────────┘
                  /commands   │   纯文本 / 图片 / 文档
                              ▼
                 ┌────────────────────────┐        单 Chat Registry
                 │   SQLite 存储          │◀──────（FIFO 队列 +
                 │   绑定·任务·          │        活跃任务追踪）
                 │   cron·审计日志        │
                 └────────────┬───────────┘
                              │ runTurn
                              ▼
                 ┌────────────────────────┐
                 │  Claude Agent SDK      │── 流式事件 ──▶ 聊天
                 │  (driver.ts)           │
                 └────────────┬───────────┘
                              ▼
                   本地 Claude Code 会话
              （在绑定目录里启动或恢复）

   node-cron ──▶ 定时提示进入同一条管线分发
```

每个 Telegram 会话绑定到**一个白名单项目目录**。每条提示会在该目录启动（或恢复）一个 Claude Code 会话，助手输出流式回传聊天。单 Chat FIFO 队列保证任务串行——`/stop` 中断当前任务，`/drop` 清空队列。

---

## 功能特性

| | 特性 | 说明 |
| :--: | :--- | :--- |
| 🌊 | **流式回复** | 渐进式 Rich Message 编辑流式输出，完整 Markdown（表格、代码、LaTeX），HTML→纯文本降级。 |
| 🗂️ | **会话管理** | 跨项目列出、恢复、切换 Claude Code 会话。 |
| 📋 | **任务队列** | 单 Chat FIFO。`/stop` 中断运行中任务，`/drop` 清空等待中的。 |
| ⏰ | **定时任务** | cron 式提示（`/cron`）分发到 Claude Code，可列出/启用/禁用/删除。 |
| 🖼️ | **多模态输入** | 发图片、PDF、文本/代码/日志文件配合提示。 |
| 🧩 | **技能浏览** | `/skills` 列出可用 Skills，点击填入输入栏。 |
| ➕ | **新建项目** | `/projects` 里点 `➕ 新建项目`，`git init` 脚手架新目录。 |
| 📊 | **上下文用量** | `/context` 显示上一轮上下文窗口占比（带可视化条）。 |
| ⌨️ | **输入指示器** | 工作时显示 Telegram"正在输入…"。 |
| 🛡️ | **护栏** | 轮次上限、每日成本/Token 上限、审计日志、交互式工具审批。 |
| 🖥️ | **Web 管理控制台** | 实时任务、成本、工具用量、日志、配置编辑。 |

---

## 命令一览

| 命令 | 说明 |
| :--- | :--- |
| `/projects` | 列出项目（点击切换）；底部 `➕ 新建项目` |
| `/project <name>` | 按名切换活跃项目 |
| `/bind <path>` | 绑定到显式白名单路径 |
| `/unbind` | 解绑当前会话的项目 |
| `/new` | 开启全新 Claude Code 会话 |
| `/auto [off]` | 持久自动会话模式 |
| `/sessions [all]` | 列出会话（点击切换） |
| `/switch <id>` | 按 ID 切换会话 |
| `/stop` | 中断运行中任务 |
| `/tasks` | 活跃 + 近期任务 |
| `/queue` | 查看队列 |
| `/drop` | 清空队列 |
| `/cron <schedule> \| <prompt>` | 定时任务 |
| `/cron list \| rm <id> \| enable <id> \| disable <id>` | 管理定时任务 |
| `/context` | 上一轮上下文窗口用量（%） |
| `/skills` | 浏览可用 Skills（点击使用） |
| `/approve auto\|interactive\|list\|clear <tool\|all>` | 工具调用审批模式 |
| `/help` | 显示此列表 |

**键盘按钮：** `项目` `会话` `新建` — `停止` `队列` `任务` — `审批`

**纯文本**、**图片** 或 **文档** → 直接送给 Claude Code（流式）。

---

## 配置

CoBot 读取**两层**配置：环境变量（`.env`）管密钥/运行时，`config.yaml` 管结构/配额。重叠处环境变量优先。

<details>
<summary><b>.env</b> —— 环境变量</summary>

```bash
# ---- Claude Code ----
CLAUDE_MODEL=                 # 派生会话默认模型（可选）
CLAUDE_PERMISSION_MODE=acceptEdits   # acceptEdits | bypassPermissions | default | plan
CLAUDE_TASK_TIMEOUT_MS=1800000        # 单任务墙钟上限（30 分钟）。0 = 关闭
CLAUDE_ALLOWED_TOOLS=                 # 如 "Bash(git *),Edit,Read"
CLAUDE_ALLOW_DANGEROUS_SKIP_PERMISSIONS=false   # 危险开关，默认关
CLAUDE_MAX_TURNS=                     # 单任务轮次上限（默认 50）

# ---- CoBot ----
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_USERS=
COBOT_DB_PATH=./data/cobot.db
COBOT_PROXY=http://127.0.0.1:10808    # 访问 Telegram 的出站代理（可选）
LOG_LEVEL=info                          # trace | debug | info | warn | error

# ---- Hermes（可选后端 v1.5）----
# HERMES_API_URL=http://127.0.0.1:8642
# HERMES_API_KEY=
```
</details>

<details>
<summary><b>config.yaml</b> —— 结构与配额</summary>

```yaml
devRoots:                       # 其直接子目录即项目的目录
  - /Users/YOU/Develop
projects:                       # devRoots 之外额外白名单路径
  # - /Users/YOU/.hermes

telegram:
  botToken: ""                  # 或写 .env
  allowedUsers: [12345678]
  maxEditChars: 3500           # 触发新消息追加的字符阈值
  pollTimeout: 30              # 长轮询超时（秒）
  flushMs: 900                 # 流式编辑间隔（毫秒）

approval:                      # 交互式工具调用审批
  mode: auto                   # auto | interactive
  timeoutMs: 300000
  timeoutAction: allow         # allow | deny（用户未响应时）
  skipTools: [Read, LS, Glob, Grep, TodoWrite]   # 永不提示（只读）

defaults:
  maxTurns: 50                 # 0 = 无限
  dailyCostCapUsd: 5.0         # 单 Chat 每日成本上限（省略 = 不限）
  dailyTokenCap: 200000        # 单 Chat 每日 Token 上限

admin:
  enabled: true
  host: "127.0.0.1"
  port: 8085
  apiKey: ""                   # 管理 API bearer token
```
</details>

---

## 安全与护栏

CoBot 是一个拥有**本地代码执行能力**的无值守 Agent，因此自带护栏，让自动化使用**可控且可观测**。

- **用户白名单** —— `TELEGRAM_ALLOWED_USERS` 管控访问，未授权用户直接忽略。
- **路径白名单** —— `/bind` 只接受 `config.yaml` 中 `devRoots` / `projects` 下的路径。
- **单任务轮次上限** —— `DEFAULT_MAX_TURNS = 50`（用 `CLAUDE_MAX_TURNS` 或 `defaults.maxTurns` 覆盖；`0` = 无限）。
- **单 Chat 每日配额** —— `dailyCostCapUsd` / `dailyTokenCap` 超限即拒新任务；本地午夜重置。
- **审计日志** —— 每个任务记入 `audit_logs` 表（chatId、prompt、工具、costUsd、耗时、Token、contextUsagePct、状态），便于成本核算与取证。
- **交互式工具审批** —— `/approve interactive` 在写操作前提示；`skipTools` 内只读工具跳过提示；点 ✅/❌/⭐（永久允许）。模式与"永久允许"规则持久化到 SQLite。定时任务一律自动审批。默认模式为 `auto`（无值守）；设 `COBOT_APPROVAL_TIMEOUT_ACTION=deny` 即失败闭合。
- **墙钟看门狗** —— `CLAUDE_TASK_TIMEOUT_MS` 会中止卡死的任务（如等待权限提示），避免阻塞聊天。
- **权限模式** —— 默认 `acceptEdits`（无值守自动接受文件编辑）。`CLAUDE_ALLOW_DANGEROUS_SKIP_PERMISSIONS` **默认关闭**。

---

## Web 管理控制台

CoBot 自带一个仪表盘（`admin.enabled: true`），地址 `http://127.0.0.1:8085`，用 `admin.apiKey` bearer token 鉴权。提供：

- **概览大盘** —— 在线时长、活跃任务、累计任务数与成功率、累计成本与 Token、近 7 天走势、工具用量榜
- **任务与审计** —— 完整历史，含成本、耗时、状态、prompt 回放
- **定时任务** —— 列出/启用/禁用/删除
- **绑定与授权** —— 哪个会话绑了哪个项目
- **系统配置** —— 查看/编辑运行时配置（原始 YAML）
- **实时日志** —— 流式电传打印机式 bot 输出

> 设计语言：暗色"调度控制台"——琥珀色（工作中）、薄荷色（健康）、紫罗兰（待关注）——搭配 Space Grotesk + IBM Plex Mono。见 [`src/admin/web/index.html`](./src/admin/web/index.html)。

---

## 开发

```bash
npm test                # 226 个测试，Node 内置 runner
npm run typecheck       # tsc --noEmit
npm run rebuild:native  # Node 版本变更后重编 better-sqlite3
npm run dev             # 前台，热重载
```

> **CI 提示：** `better-sqlite3` 是原生模块。`npm ci` 之后需跑 `npm run rebuild:native`，让二进制匹配 CI 的 Node 版本，否则 Store 相关测试会 `ERR_DLOPEN_FAILED`。

### 源码结构

```
src/
├── bot/        — grammY 初始化、命令、运行、流式、媒体、审批
├── claude/     — Agent SDK 驱动 + 类型 + 会话（SDK 的唯一边界）
├── registry/   — 单 Chat 活跃任务追踪 + FIFO 队列
├── store/      — SQLite（better-sqlite3）：绑定、任务、cron、审计
├── scheduler/  — node-cron 管理器
├── admin/      — Web 管理 HTTP 服务 + 静态控制台
├── util/       — 代理、http、Telegram HTML 格式化、日志
└── index.ts    — 入口
```

### 架构约束（给贡献者）

- **SDK 隔离** —— `src/claude/driver.ts` 是*唯一* import `@anthropic-ai/claude-agent-sdk` 的地方。Bot/registry 层只通过 `src/claude/types.ts` 的 `DriverEvent` 联合类型与之通信。
- **非阻塞** —— 绝不在 grammY update handler 里 `await` 长任务（会阻塞 `/stop`）。用 `void runOne(...)` / `submitInteractive`。
- **流式** —— `TelegramStreamer` 有两级长度控制：`maxEditChars`（新消息阈值，默认 3500）与 `TG_HARD_LIMIT = 32000`（Telegram 单消息硬上限）。所有发送串行化以避免 edit 限频。

完整开发者/Agent 指南见 [`AGENTS.md`](./AGENTS.md)，开发指南见 [`docs/development.md`](./docs/development.md)。

---

## 常见问题

<details>
<summary><b>机器人启动了但不响应 / "Telegram init timed out"</b></summary>

你的网络到不了 `api.telegram.org`。在 `.env` 设 `COBOT_PROXY`（或 `HTTPS_PROXY`）。macOS 上 CoBot 会通过 `scutil --proxy` 自动探测系统代理。
</details>

<details>
<summary><b>测试报 <code>ERR_DLOPEN_FAILED</code></b></summary>

`better-sqlite3` 原生二进制与你的 Node 版本不匹配。跑 `npm run rebuild:native`。
</details>

<details>
<summary><b>启动报 409 Conflict</b></summary>

上一个 bot 实例还在轮询。CoBot 会自动重试；若持续，`cobot stop` 再 `cobot start`。
</details>

<details>
<summary><b>怎么限制 Claude Code 能做什么？</b></summary>

`CLAUDE_ALLOWED_TOOLS` 限制工具；`/approve interactive` 在写操作前提示；`CLAUDE_MAX_TURNS` 和每日配额约束失控花费。最严格姿势：设 `COBOT_APPROVAL_TIMEOUT_ACTION=deny`。
</details>

<details>
<summary><b>我的代码会离开我的机器吗？</b></summary>

不会。CoBot 通过 Agent SDK 驱动**本地** Claude Code，源文件、prompt、会话状态都留在宿主机上。只有发往 Telegram 的聊天流量经过网络。
</details>

---

## 参与贡献

欢迎贡献！请先读 [`AGENTS.md`](./AGENTS.md)——其中记录的架构约束（SDK 隔离、非阻塞 handler、流式不变量）是每次改动都必须遵守的。

1. Fork 后建分支（`git checkout -b feat/my-feature`）
2. 提交前 `npm test && npm run typecheck`
3. 开 PR 描述改动并关联 issue

贡献即代表你同意将其按本项目 [MIT 协议](#开源协议)授权。

---

## 开源协议

[MIT](./LICENSE) © [zaneven](https://github.com/zaneven)

Claude Code 与 Claude Agent SDK 是 Anthropic 的产品。CoBot 是独立的社区项目，与 Anthropic 无隶属关系，也未获其背书。
