# CoBot 应用分析（Agent 应用视角）

> 分析日期：2026-08-10
> 视角：把 CoBot 当作一个「Agent 应用」（通过聊天界面远程驱动具备工具调用能力的自主 Agent）来评估。
> 依据：源码通读（src/ 全模块）、AGENTS.md、README、实跑 typecheck + test。

---

## 1. 它到底是什么

CoBot 不是「问答机器人」，而是一个**远程 Agent 操作台**：用 grammY 把 Telegram 聊天界面嫁接到本地的 Claude Code（经 `@anthropic-ai/claude-agent-sdk` 驱动），让用户在手机/电脑上通过一个聊天窗口，远程指挥一个能读文件、写代码、跑命令、调工具的**自主 Agent**。

典型的「Agent 应用」特征，它几乎占全了：

| Agent 特征 | CoBot 中的体现 |
| :--- | :--- |
| 自主工具调用 | 默认 `acceptEdits` 自动批准，可切 `bypassPermissions` 全放行 |
| 长任务流式执行 | `TaskDashboard` 卡片原地刷新 + `SilenceIndicator` 心跳；答案正文 `sendRichText` 收尾投递 |
| 会话/状态持久化 | SQLite 存 `bindings` / `running_tasks` / `cron_jobs`，可 resume 会话 |
| 定时自主任务 | `CronManager` 按 cron 触发，跨触发复用同一会话 |
| 多模态输入 | 图片/PDF/文本文件 → 多模态 content block |
| 无人值守运行 | Headless：看门狗超时 + `maxTurns` 双重护栏 |

---

## 2. 架构总览

```
Telegram (long-poll)
   │  message / callback_query
   ▼
grammY Bot (bot.ts)
   ├─ 授权门：allowedUsers
   ├─ 命令路由 + 中文键盘别名
   └─ retryOn429 transformer
          │
          ▼
  提交层 runs.ts
   ├─ submitInteractive()  空闲即跑 / 忙碌入队（非阻塞）
   ├─ runOne()             同步 registry.start → runTurn → registry.finish → drainQueued
   └─ drainQueued()        队列消费（下一个 runOne 同步启动，消除并发缝隙）
          │
          ▼
  Registry (registry.ts)  —— 每 chat 一个活跃任务 + FIFO 内存队列
          │
          ▼
  runTurn()  ──► runClaude() [driver.ts：SDK 唯一边界]
   │                └─ query() 流式；watchdog 超时；canUseTool 自动批准
   ├─ TelegramStreamer   Rich → HTML → plain 三级降级
   ├─ SilenceIndicator    typing / thinking / compacting 心跳
   └─ 收尾统计 token / cost / contextUsagePct
          │
          ▼
  Claude Agent SDK ──► 本地 Claude Code（cwd = 绑定项目）
          ▲
          │ 持久化
   Store (db.ts, better-sqlite3 WAL)
   ├─ bindings       聊天↔项目↔session
   ├─ running_tasks  审计 + 启动 sweep 残留
   └─ cron_jobs      定时任务注册表
          ▲
          │ 另起调度
   CronManager (cron.ts, node-cron) ── 到点 fire → runOne
```

---

## 3. 做对了什么（Agent 应用的设计亮点）

1. **SDK 严格隔离**：`src/claude/driver.ts` 是 Agent SDK 唯一边界，Bot/Registry 只消费 `DriverEvent` 联合类型，不碰 SDK 原始类型。干净、可测、低耦合。
2. **单 Chat FIFO + 并发防护**：`registry.start()` 在 `await runTurn()` **之前**同步调用，杜绝「新消息在缝隙里并发起第二个活跃任务」。
3. **非阻塞 Fire-and-Forget**：更新循环永不 `await` 长任务，保证 `/stop` 等指令随时响应。
4. **双重超时护栏**：`taskTimeoutMs` 看门狗（防挂死）+ `maxTurns` 上限（防工具循环失控，封顶 200）。
5. **流式 UX 三板斧**：Rich Message 优先 → HTML 降级 → 纯文本兜底；`sanitizeStreamMarkdown` 修复未闭合代码块；`maxEditChars`(3500) 与 `TG_HARD_LIMIT`(32000) 两级长度控制；Promise 链串行节流避免 edit 限频。
6. **静默期可见性**：`SilenceIndicator` 在 Agent 长思考/压缩上下文时给出心跳，把「卡死」和「在想」区分开。
7. **代理自适应**：`proxy.ts` 从 ENV 与 macOS `scutil` 探测代理，规避 Telegram 在 TLS 拦截链路下 500s 静默挂起。
8. **崩溃自愈**：启动 `sweepStaleRunning()` 把上次崩留下的 `running` 标记为 `aborted`。
9. **上下文可观测**：`computeContextUsagePct` 含第三方模型 `[?M]` 后缀兜底，跨模型算窗口占用。
10. **工程素养**：分层清晰、注释密度高且解释「为什么」、类型安全、测试分层（driver/streaming/tgfmt/db/registry/commands/runs/media/config 共 103 用例）。

---

## 4. 风险与薄弱点（Agent 应用特有风险）

### 4.1 安全面（最高优先级）
- 默认 `acceptEdits`、可配 `bypassPermissions` = 本地代码执行权。Headless 全权执行，**一旦 `TELEGRAM_BOT_TOKEN` 或 `allowedUsers` 泄漏 = 开放本机 RCE**。
- 缺乏：操作审计（谁、跑了什么、调了哪些工具、花多少）、命令级白名单（仅有 `allowedTools` 可选但未默认收敛）、dry-run/sandbox 模式。

### 4.2 稳定性 / 恢复
- **队列仅内存**：重启丢失 pending 队列（active 任务有 sweep 缓解，但排队中的 prompt 会丢）。
- **cron 无幂等/重试**：fire 后若进程崩溃，无重试；`running_tasks` 仅审计，不参与恢复。
- **单进程单实例**：多 chat 共享一个 Node 进程与一个本地 Claude 实例，无水平扩展。

### 4.3 成本失控
- 无 per-user / per-day 的 token 或花费上限。
- `maxTurns` 默认**无上限**，仅 watchdog 兜底；长时间推理 + 大上下文可能爆成本。

### 4.4 透明度
- 工具调用汇总已在任务卡片无条件显示（`TaskDashboard` 的 `📦 工具调用`），默认透明。历史曾有 `showToolCalls` / `showThinking` 流式开关，随旧 `TelegramStreamer` 架构废弃已移除。

### 4.5 测试环境缺陷（当前阻断项）
- `better-sqlite3` 原生模块 ABI 不匹配（编译于 NODE_MODULE_VERSION 141，当前 Node 为 127），导致 `db.test.ts` 与 `runs.test.ts` 共 **4 个**用例 `ERR_DLOPEN_FAILED`。**属构建/环境问题，非逻辑错误**（代码正确）。
- 修复：`npm rebuild better-sqlite3`（README 已提示），或 CI 在 install 后加 rebuild。

### 4.6 文档漂移
- README 写「89 tests」，实际 103；架构图注释错位（auth gate 画在奇怪位置）；`/auto` 等命令说明简略。

---

## 5. 当前状态体检

| 项目 | 结果 |
| :--- | :--- |
| 类型检查 `npm run typecheck` | ✅ 通过 |
| 单元测试 `npm test` | ⚠️ 103 中 99 通过，**4 失败（全因 better-sqlite3 ABI，环境项）** |
| 代码组织 | ✅ 分层清晰，关注点分离良好 |
| 注释质量 | ✅ 高密度，强调「why」 |
| 测试覆盖 | ✅ 单元覆盖不错；❌ 缺集成/e2e、缺 SDK 边界外的端到端 |

---

## 6. 优化建议（按优先级）

### P0 —— 先把「能跑」变「可信」
1. **修构建一致性**：CI 矩阵里 `npm ci` 后加 `npm rebuild better-sqlite3`；本地执行同样操作让 4 个测试复绿。
2. **加 Agent 操作审计**：结构化记录每次 prompt、调用的工具、花费、时长，落 SQLite 或单独审计表。
3. **加花费/轮次硬护栏**：per-task `maxTurns` 默认给个保守值（如 50）；增加 per-user/per-day 花费或 token 配额。

### P1 —— 治理与可观测
4. **队列持久化**：pending 也入 SQLite，重启不丢。
5. **cron 幂等 + 重试 + 超时联动**：fire 前校验会话、失败退避、与 watchdog 对齐。
6. ~~**默认提高透明度**：`showToolCalls` 默认 `true`（或提供 `/audit` 开关）~~ ✅ 已落地：工具调用汇总在任务卡片默认显示（`TaskDashboard`）；旧 `showToolCalls` 开关随流式架构重构已移除。
7. **命令级权限收敛**：`allowedTools` 默认给出最小工具集，而非全开。

### P2 —— 扩展与一致性
8. **多实例设计**：用 chatId 分片或外部队列（Redis）支持水平扩展。
9. **成本告警**：`contextUsagePct` 达阈值（如 80%）时主动提示，避免无声溢出。
10. **文档对齐**：修正 README 测试数、架构图；补全 `/auto`、`/context`、`/skills` 说明。

---

## 7. 结论

CoBot 是一个**设计成熟、工程素养很高**的 Agent 应用范本。它正确解决了此类应用的若干硬骨头：流式 UX、并发队列、超时防护、SDK 隔离、代理与崩溃恢复。主要短板集中在**「自主 Agent 的治理与可观测性」**（安全审计、成本护栏、队列持久化）以及**构建环境一致性**。

作为个人/团队远程驱动本地 Agent 的工具，架构层面已相当完备；下一步应从「能跑」走向「可控、可观测、可扩展」。

---

## 实施进度（2026-08-10）

**P0 已全部落地并通过验证（typecheck 通过；测试 122/122 通过）：**

1. **构建一致性** ✅ — `npm rebuild better-sqlite3` 修复原生模块 ABI 不匹配（之前 4 个测试 `ERR_DLOPEN_FAILED` 已复绿）；新增 `npm run rebuild:native` 脚本并写入 README 的 CI 注意事项。
2. **Agent 操作审计** ✅ — `store/db.ts` 新增 `audit_logs` 表与 `insertAudit / sumCostSince / sumTokensSince / listAudit`；`runs.ts` 在每次任务结束后落库（prompt、调用的工具、cost、时长、token、contextUsagePct、status）。
3. **花费/轮次硬护栏** ✅ — `config.ts`：`DEFAULT_MAX_TURNS = 50`（保守默认，可被 env/yaml 覆盖，`0`=不限）；新增 `dailyCostCapUsd` / `dailyTokenCap`（per‑chat 每日花费/Token 上限）。`runs.ts` 的 `runOne` 增加统一配额闸门 `checkQuota`（交互/排队/cron 全部经此拦截），超额即拒任务并通知。

P1/P2 仍未实施（队列持久化、cron 幂等重试、默认提高工具调用可见性、多实例扩展等）。
