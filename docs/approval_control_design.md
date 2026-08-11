# CoBot 交互式工具审批（Interactive Tool Approval）技术方案

> 状态：方案设计（未实现）。日期：2026-08-10。
> 目标：把 Claude Code 的工具调用审批从「headless 全放行」改为「Telegram 内交互审批」，同时不破坏 SDK 隔离 / 非阻塞 / 单 chat 队列 / 看门狗等既有约束。

---

## 0. 现状

`src/claude/driver.ts` 在非 `bypassPermissions` 模式下：

```ts
options.canUseTool = async (toolName) => ({ behavior: "allow" });
```

即无人值守一律放行。本方案把「是否放行」交给 Telegram 用户交互决定。

---

## 1. SDK 真实 API（已核对 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;              // SDK 内置中止信号（绑定 query 的 abortController）
    suggestions?: PermissionUpdate[]; // 「本次起始终允许」的建议，回传 updatedPermissions
    toolUseID: string;                // 一次 assistant 消息内某次工具调用的唯一 id
    requestId: string;                // control_request 的 request_id（重连后会重投，需幂等）
    title?: string;                   // 桥接预渲染提示语，如 "Claude wants to read foo.txt"
    displayName?: string;             // 短名词，如 "Read file"
    description?: string;             // 副标题
    blockedPath?: string;
    decisionReason?: string;
    matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
  }
) => Promise<PermissionResult | null>;

type PermissionResult =
  | { behavior: "allow"; updatedInput?; updatedPermissions?; toolUseID?; decisionClassification? }
  | { behavior: "deny";  message: string; interrupt?; toolUseID?; decisionClassification? };
```

要点：
- **不要返回 `null`**（除非已 out-of-band 发 `control_response`）；`null` 会让工具**永久阻塞**（注释明言「permission prompts have no park deadline」）。
- **幂等**：同一 `requestId` 可能被重投，回调须按 `requestId` 去重/复用结果。
- **signal**：SDK 把 query 的 abortController 信号传进来；`/stop` / 看门狗中止会触发，handler 应 race 它 → deny。
- **suggestions + updatedPermissions**：SDK 原生支持「始终允许」；用户点「始终允许」时把 `options.suggestions` 原样回传为 `updatedPermissions`。
- **title/displayName/description**：优先用这些预渲染文本，避免自己拼。

---

## 2. 设计原则

1. **SDK 隔离**：`driver.ts` 仅做桥接，把 `canUseTool` 委托给注入的 handler；不 import grammY。
2. **非阻塞**：审批等待期间 grammY 长轮询照常处理 `callback_query`（`runOne` 本就 fire-and-forget）。
3. **单 chat 队列不变**：pending 期间任务仍 active，新消息入队。
4. **失败闭合（fail-closed）**：超时 / 中止 / 异常 → deny。
5. **默认不破坏现状**：`approval.mode` 默认 `auto`（全放行），需显式切 `interactive`。
6. **幂等**：按 `requestId` 缓存已决结果，重投直接复用。

---

## 3. 数据流（见上方流程图）

SDK 调 `canUseTool` → driver 转给 `ApprovalManager` → 发 inline 键盘到 chat → 用户点按 → grammY callback → resolve → driver 返回 `PermissionResult` → SDK 执行/拒绝工具 → 结果流式回显。
旁路：超时 / abort → deny；`alwaysAllow` / `skipTools` 命中 → 直接 allow 不发键盘。

---

## 4. 模块改动

### 4.1 `src/claude/types.ts`

```ts
export interface PermissionRequest {
  requestId: string;      // = options.requestId，幂等键
  toolUseID: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;         // 优先展示
  displayName?: string;
  description?: string;
  suggestions?: PermissionUpdate[]; // 透传，用于「始终允许」
  cwd: string;
}

export type PermissionDecision =
  | { behavior: "allow"; updatedPermissions?: PermissionUpdate[] }
  | { behavior: "deny"; message: string };

// RunParams 新增：
canUseToolHandler?: (req: PermissionRequest, signal: AbortSignal) => Promise<PermissionDecision>;
```

### 4.2 `src/claude/driver.ts`

替换硬编码的 `canUseTool`：

```ts
if (params.permissionMode !== "bypassPermissions") {
  options.canUseTool = async (toolName, input, opts) => {
    if (!params.canUseToolHandler) return { behavior: "allow" }; // 兼容旧默认
    const req: PermissionRequest = {
      requestId: opts.requestId, toolUseID: opts.toolUseID,
      toolName, input,
      title: opts.title, displayName: opts.displayName, description: opts.description,
      suggestions: opts.suggestions, cwd: params.cwd,
    };
    const dec = await params.canUseToolHandler(req, opts.signal);
    return dec.behavior === "allow"
      ? { behavior: "allow", updatedPermissions: dec.updatedPermissions }
      : { behavior: "deny", message: dec.message };
  };
}
```

driver 不再无条件 allow；handler 缺省时维持原行为。

### 4.3 新建 `src/bot/approval.ts` — `ApprovalManager`

单例，持有：
- `pending: Map<requestId, Pending>` — `Pending = { resolve, timer, chatId, toolName, decided }`
- `decided: Map<requestId, PermissionDecision>` — 幂等缓存（近期，限时清理）
- `alwaysAllow: Map<chatId, Set<toolName>>` — per-task「始终允许」（任务结束清理）

方法：
- `request(req, { api, chatId, indicator, mode, skipTools, requireTools, timeoutMs }, signal): Promise<PermissionDecision>`
  - 幂等：`decided` 命中 → 直接返回。
  - 策略 `decidePolicy(mode, toolName, skipTools, requireTools)` → `allow` / `ask`：
    - `alwaysAllow` 命中或 skipTools 命中或 mode=auto → `allow`（不发键盘）。
    - 否则 → `ask`。
  - 交互：发 inline keyboard（✅ 允许 / ❌ 拒绝 / ⭐ 始终允许），`callback_data = appr:<shortId>:<act>`。
    - 文案优先用 `req.title`，否则 `displayName + inputSummary`。
    - `indicator` 提示「⏸ 等待审批: <tool>」。
  - 等待：`new Promise` + `setTimeout(timeoutMs)` → 超时 deny("审批超时")；`signal` abort → deny("已中止")。三者 race。
- `handleCallback(ctx)`：解析 `appr:<shortId>:<act>`，校验 chatId 一致，resolve 并编辑消息显示结果，清 timer，写 `decided`。`act ∈ allow | deny | always`（always → 加 `alwaysAllow` 并 allow）。
- `cancelForChat(chatId)`：拒绝该 chat 所有 pending（任务结束 / `/stop` 时清理）。

### 4.4 `src/bot/runs.ts`

- `runTurn` 构造 handler 闭包并传入 `runClaude`：
  ```ts
  const handler = (req, signal) => approvalManager.request(req, {
    api, chatId, indicator,
    mode: config.claude.approval.mode,
    skipTools: config.claude.approval.skipTools,
    requireTools: config.claude.approval.requireTools,
    timeoutMs: config.claude.approval.timeoutMs,
  }, signal);
  // ...
  await runClaude({ ..., canUseToolHandler: handler });
  ```
- `finally`：`approvalManager.cancelForChat(chatId)` 清残留 pending。
- 约束：`approval.timeoutMs` 必须 `< claude.taskTimeoutMs`（否则看门狗先到）。配置加载时 clamp + 告警。

### 4.5 `src/bot/bot.ts`

- 注册 `bot.callbackQuery(/^appr:/, (ctx) => approvalManager.handleCallback(ctx))`。

### 4.6 `src/config.ts`

```ts
claude.approval: {
  mode: "auto" | "interactive" | "strict"; // default "auto"
  skipTools: string[];     // 默认只读：Read, LS, Glob, Grep, TodoWrite
  requireTools: string[];  // 强制 ask（覆盖 mode）
  timeoutMs: number;       // 单次审批超时，默认 600_000 (10m)，须 < taskTimeoutMs
}
```
env：`COBOT_APPROVAL_MODE`、`COBOT_APPROVAL_TIMEOUT_MS`。

### 4.7 命令（`commands.ts` + `bot.ts`）

- `/approve auto|interactive|strict`：切本 chat 模式（in-memory，存 registry；或落 bindings 持久化）。
- 可选 `/approve timeout <min>`。

---

## 5. 策略矩阵

| mode | skipTools 命中 | 普通写/执行工具 | requireTools 命中 |
|---|---|---|---|
| auto | allow | allow | ask |
| interactive | allow | ask | ask |
| strict | ask | ask | ask |

优先级：`alwaysAllow` > `requireTools` > `skipTools` > `mode`。

---

## 6. permissionMode 交互（重要）

- `bypassPermissions`：SDK 不调 `canUseTool` → 不受影响（仍全自动）。
- `acceptEdits`：SDK 可能对「编辑类」工具短路放行、**不调** `canUseTool`；若要连编辑也审批，用 `default` 模式。
- **推荐**：开启交互审批时 `permissionMode: default`，由本方案 handler 统一决策。
- **待验证项**：`acceptEdits` 是否在调 `canUseTool` 前短路编辑——写一个探针测试确认（影响是否必须用 `default`）。

---

## 7. 边界与风险

- **callback_data ≤64B**：`requestId` 可能较长 → 用自增 `shortId` 映射到 `requestId`，`callback_data = appr:<shortId>:<act>`。
- **竞态**：用户点击 vs 超时/abort 同时 → Promise once 守卫，先到生效，后到忽略；消息编辑失败吞掉。
- **重复 resolve**（双击/重投）：`decided` 缓存 + `pending` 删除后忽略。
- **pending 期间 `/stop`**：abort → handler deny → SDK 中止；`cancelForChat` 兜底。
- **多 pending**：SDK 串行调 `canUseTool`（一次一个工具），通常 1 个；Map 仍支持多。
- **Telegram 限频**：审批消息走既有 `retryOn429`；编辑「已决定」时若 429 吞掉即可。
- **看门狗**：审批等待计入任务时长；`approval.timeoutMs < taskTimeoutMs` 必须成立，否则看门狗先杀任务（体验差）。配置 clamp + 启动告警。
- **安全**：审批消息含命令/路径摘要，截断避免泄露敏感内容到聊天。
- **审计**：每次审批决策落 `audit_logs`（扩展字段或单独 `approval_decisions` 表）——建议 Phase 2。

---

## 8. 测试计划

- **driver.test**
  - 无 handler → `{behavior:"allow"}`（兼容）。
  - handler 返回 allow/deny → 正确映射 `PermissionResult`。
  - 透传 `requestId`/`toolUseID`/`title`/`suggestions`。
- **approval.test**（纯逻辑，mock api）
  - policy：各 mode × 工具分类 → allow/ask。
  - `request` → `handleCallback(allow)` → resolve allow；deny 同理。
  - 超时 → deny；abort → deny；重复 resolve 忽略；他 chat 点击无效。
  - `always` → `alwaysAllow` 命中后同工具直接 allow 不发包。
  - 幂等：同 `requestId` 二次 `request` → 复用已决结果。
- **runs 集成**（mock SDK）：审批 pending 时 `/stop` 能中止且无残留 pending。

---

## 9. 分阶段落地

- **Phase 1（最小可用）**：types + driver 桥接 + `ApprovalManager`（allow/deny/timeout/abort/幂等）+ bot callback 路由 + `interactive` 模式 + config + 基础测试。
- **Phase 2**：「始终允许」（`updatedPermissions`/`alwaysAllow`）+ `/approve` 命令 + 模式持久化（落 bindings）。
- **Phase 3**：策略可配（`requireTools`/`skipTools`）+ 审批富文本（`title`/`description`/命令摘要）+ 审批决策审计落库 + 超时告警。

---

## 10. 待确认决策

1. 默认模式：`auto`（不破坏现状，推荐）还是 `interactive`（更安全但每次都要点）？
2. 超时默认行为：`deny`（fail-closed，推荐）还是 `allow`？
3. 「始终允许」粒度：按工具（per-task）还是落库长期生效？
4. 模式持久化：仅内存（重启重置）还是写 bindings？
5. Phase 1 是否即支持 `strict`，还是先只做 `interactive`？

---

## 11. 实施进度（2026-08-10）

**决策（已确认）**：① 默认 `auto` ② 超时 `allow` ③ 「始终允许」落库长期 ④ 模式持久化到 `bindings` ⑤ Phase 1 只做 `interactive`（不含 `strict`）。

**Phase 1 + Phase 2 已实现并通过验证**（typecheck 通过；测试 140/140 通过，新增 18 个）：

- `src/claude/types.ts`：`PermissionRequest` / `PermissionDecision` / `RunParams.canUseToolHandler`。
- `src/claude/driver.ts`：`canUseTool` 桥接（委托 handler，透传 `requestId`/`toolUseID`/`title`/`suggestions`/`signal`，映射 `PermissionResult`，不返回 `null`）；导出 `buildPermissionRequest` / `toSdkPermissionResult`。
- `src/store/db.ts`：`approval_rules` 表 + `bindings.approval_mode` 列（含旧库迁移）+ `isAlwaysAllowed`/`addAlwaysAllow`/`listAlwaysAllow`/`clearAlwaysAllow`/`setApprovalMode`。
- `src/bot/approval.ts`（新）：`ApprovalManager`——policy 短路（auto/skipTools/alwaysAllow）、inline 键盘 ✅/❌/⭐、三路 race（用户点击 / 超时→`timeoutAction` / abort→deny）、`requestId` 幂等、`shortId` 映射 `callback_data`、`cancelForChat` 兜底。
- `src/bot/runs.ts`：注入 handler（cron 强制 auto 不弹审批）+ finally `cancelForChat`。
- `src/bot/bot.ts`：注册 `callbackQuery(/^appr:/)` + `/approve` + `审批` 键盘别名。
- `src/bot/commands.ts`：`handleApprove`（`auto|interactive|list|clear <tool|all>`）。
- `src/config.ts`：`claude.approval { mode, skipTools, timeoutMs, timeoutAction }`，`timeoutMs` 自动 clamp < `taskTimeoutMs`。
- 测试：`driver.test`（mapper）、`approval.test`（10 例）、`db.test`（approval 5 例）。

**待办（Phase 3）**：`strict` 模式、`requireTools` 可配、审批富文本（`title`/`description`）、审批决策落 `audit_logs`、超时告警、`acceptEdits` 短路探针验证。
