# CoBot

A standalone TypeScript Telegram bot that drives and interacts with locally-active Claude Code conversations via the Claude Agent SDK.

## What it does

- **Streaming replies** — Claude's output streams into the chat via progressive Rich Message edits with Markdown rendering (tables, code blocks, LaTeX).
- **Session management** — list, resume, and switch between Claude Code sessions across projects.
- **Task queue** — FIFO per-chat queue; `/stop` interrupts the running task, `/drop` clears waiting ones.
- **Scheduled tasks** — cron-style prompts dispatched to Claude Code (`/cron`).
- **Multimodal input** — send photos (image), PDFs, or text/code/log files alongside your prompt.
- **Skill browser** — `/skills` shows available skills; tap to fill the input bar.
- **Project creation** — tap `➕新建项目` in `/projects` to create a new project directory with `git init`.
- **Context usage** — `/context` shows the last turn's context-window percentage with a visual bar.
- **Typing indicator** — Telegram "typing…" status while the bot works.
- **Rich Message** — All error & result messages use `sendRichMessage` with HTML → plain-text fallback.

## Quick start

```bash
cp .env.example .env        # set TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USERS
cp config.example.yaml config.yaml   # whitelist your dev roots
npm install
npm rebuild better-sqlite3  # if Node version changed
npm start
```

## Commands

| Command | Description |
|---|---|
| `/projects` | List projects (tap to switch); `➕ 新建项目` button at bottom |
| `/project <name>` | Switch active project by name |
| `/bind <path>` | Bind to an explicit path |
| `/unbind` | Unbind this chat from its project |
| `/new` | Start a fresh Claude Code session |
| `/auto [off]` | Persistent auto session mode |
| `/sessions [all]` | List sessions (tap to switch) |
| `/switch <id>` | Switch active session by ID |
| `/stop` | Interrupt the running task |
| `/tasks` | Active + recent tasks |
| `/queue` | Show queued prompts |
| `/drop` | Clear queued prompts |
| `/cron <schedule> \| <prompt>` | Schedule a task |
| `/cron list / rm <id> / enable <id> / disable <id>` | Manage cron jobs |
| `/context` | Last turn's context-window usage (%) |
| `/skills` | Browse available Skills (tap to use) |
| `/approve auto\|interactive\|list\|clear <tool\|all>` | Tool-call approval mode |
| `/help` | Show this list |

**Keyboard buttons:** `项目` `会话` `新建` — `停止` `队列` `任务` — `审批`

**Plain text** or **photo/document**: sends the input to Claude Code (streaming).

## Architecture

```
Telegram (long-poll) ──► grammY bot ──► Registry (per-chat queue)
                              │                    │
                         [auth                                          gate]  │
                              │                    ▼
                           '/commands'     runs.ts → runTurn → runClaude (Agent SDK → Claude Code)
                                                │
                          StreamingRich Msg ────┘ (content cells stream via sendRichMessage)
                              │
                          SQLite (store) ←─ bindings / running_tasks / cron_jobs
                              │
                        SnsCron (node-cron) ──► scheduled Claude Code tasks
```

## Project structure

```
src/
├── bot/
│   ├── bot.ts              — grammY setup, middleware, command routes
│   ├── commands.ts          — all slash-commands + keyboard + handles
│   ├── runs.ts               — runTurn / runOne / submitInteractive / queue drain
│   ├── streaming.ts        — TelegramStreamer (sendRichMessage → HTML → plain)
│   ├── indicator.ts         — SilenceIndicator heartbeat
│   └── media.ts             — photo/document → multimodal PromptInput
├── claude/
│   ├── driver.ts            — runClaude (Agent SDK wrapper, streaming, tool‑approve)
│   ├── sessions.ts          — list / find / session-info via SDK
│   └── types.ts             — DriverEvent, PromptInput, MediaAttachment
├── registry/
│   └── registry.ts          — per-chat active-run + FIFO queue + auto mode
├── store/
│   └── db.ts                — SQLite bindings / running_tasks / cron_jobs
├── scheduler/
│   └── cron.ts              — CronManager: register, dispatch, abort
├── config.ts                — YAML + env config loader
├── util/
│   ├── send.ts              — sendRichText (Rich → HTML → plain)
│   ├── tgfmt.ts             — Markdown → Telegram HTML converter (79 tests)
│   ├── proxy.ts             — proxy agent for Telegram from env/scutil
│   ├── http.ts               — downloadBuffer through proxy
│   └── logger.ts            — pino logger
└── index.ts                 — entry point
```

## Safety

- `TELEGRAM_ALLOWED_USERS` gate — unauthorized users ignored.
- `/bind` only accepts paths whitelisted in `config.yaml` (`devRoots`).
- Permission mode defaults to `acceptEdits` (headless: auto‑approves tool use).

## Guardrails

CoBot is a headless agent with local code‑execution power, so it ships guardrails
to keep autonomous use **controllable and observable**:

- **Per‑task turn cap** — `DEFAULT_MAX_TURNS = 50` (override via `CLAUDE_MAX_TURNS`
  or `defaults.maxTurns` in `config.yaml`; set `0` for unlimited).
- **Per‑chat daily quota** — optional `dailyCostCapUsd` / `dailyTokenCap`
  (env `COBOT_DAILY_COST_CAP_USD` / `COBOT_DAILY_TOKEN_CAP`, or `defaults.*`).
  When a chat's spend/tokens for the day exceed the cap, new tasks are rejected
  with a notice. The window resets at local midnight.
- **Audit log** — every task is recorded in the `audit_logs` table
  (`chatId`, `prompt`, tools used, `costUsd`, `durationMs`, token counts,
  `contextUsagePct`, `status`). Query it for cost accounting and forensics.
- **Interactive tool approval** — `/approve interactive` prompts before mutating
  tool calls (read‑only tools in `skipTools` skip the prompt); tap ✅/❌/⭐
  (always allow). Mode and "always allow" rules persist in SQLite. Cron tasks
  always auto‑approve (unattended). Default mode is `auto` (headless). Timeout
  action defaults to `allow` ("approve when present, auto‑run when away") — set
  `COBOT_APPROVAL_TIMEOUT_ACTION=deny` to fail closed.

## Testing

```bash
npm test                # 122 tests, Node built‑in runner
npm run typecheck      # tsc --noEmit
npm run rebuild:native # rebuild better-sqlite3 after a Node version change
```

> **CI note:** `better-sqlite3` is a native module — after `npm ci`, run
> `npm run rebuild:native` (or `npm rebuild better-sqlite3`) so the binary
> matches the CI Node version, or the Store‑backed tests fail with
> `ERR_DLOPEN_FAILED`.

| File | Tests | Covers |
|---|---|---|
| `commands.test.ts` | 8 | project keyboard pagination, grid layout |
| `media.test.ts` | 5 | photo/PDF/media dispatch |
| `streaming.test.ts` | 16 | Rich Markdown markup, pipeline, fallback |
| `driver.test.ts` | 2 | buildSdkPrompt fast/slow path |
| `runs.test.ts` | 3 | submitInteractive queue/enqueue/await |
| `db.test.ts` | 36 | SQLite CRUD for bindings, adds, updates, cron, **audit log** |
| `registry.test.ts` | 8 | enqueue/dequeue/drop, auto mode |
| `tgfmt.test.ts` | 30 | HTML conversion + escape + table rendering |
| `config.test.ts` | 6 | config loading, clamp/num helpers |

See [`docs/`](docs/) for command reference, development guide, and Markdown rendering details.