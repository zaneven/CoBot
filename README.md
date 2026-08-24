<p align="center">
  <b>English</b> &nbsp;|&nbsp; <a href="./README.zh-CN.md">中文</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/zaneven/CoBot/main/docs/assets/logo.svg">
    <img alt="CoBot" width="120" src="https://raw.githubusercontent.com/zaneven/CoBot/main/docs/assets/logo.svg">
  </picture>
</p>

<h1 align="center">CoBot</h1>

<p align="center">
  Drive your local <strong>Claude Code</strong> from Telegram.<br/>
  A self-hosted TypeScript bot that bridges a Telegram chat to locally-active Claude Code sessions — streaming replies, scheduled tasks, multimodal input, and a built-in admin console.
</p>

<p align="center">
  <a href="https://zaneven.github.io/CoBot/">Landing page</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="./docs/">Docs</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#license">License</a>
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

## ✨ Why CoBot

Claude Code is a powerful agentic coding tool — but it lives in your terminal. **CoBot puts it in your pocket:** from any phone, send a message to Telegram and Claude Code starts (or resumes) a session in your project directory, streaming its work back to the chat. It is fully self-hosted, your code never leaves your machine, and it ships with the guardrails an autonomous code-executing agent needs.

**Highlights**

- 📱 **Talk to Claude Code from Telegram** — any device, anywhere
- 🌊 **Streaming Markdown** replies (tables, code blocks, LaTeX) via progressive Rich Message edits
- 🗂️ **Multi-project sessions** — switch projects and resume sessions right from chat
- ⏰ **Cron-scheduled prompts** — "every morning, run the test suite and report back"
- 🖼️ **Multimodal input** — send photos, PDFs, log files alongside your prompt
- 🛡️ **Guardrails** — per-task turn cap, daily cost/token quotas, audit log, interactive tool approval
- 🖥️ **Built-in Web Admin console** — live tasks, costs, tool usage, logs, config
- 🔒 **Self-hosted** — your code stays on your machine; a user allowlist gates access

---

## 📋 Table of contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Features](#features)
- [Commands](#commands)
- [Configuration](#configuration)
- [Safety & guardrails](#safety--guardrails)
- [Web admin console](#web-admin-console)
- [Development](#development)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Quick start

### Prerequisites

| Need | How to get it |
| :--- | :--- |
| **Node.js ≥ 20** | <https://nodejs.org> |
| **Claude Code** installed & authenticated locally | `claude` CLI must run on this machine — CoBot drives it via the Agent SDK |
| **Telegram bot token** | create a bot with [@BotFather](https://t.me/BotFather) |
| **Your Telegram user ID** | [@userinfobot](https://t.me/userinfobot) prints it |

> ℹ️ CoBot talks to the machine's **local** Claude Code. It does not call the Anthropic API directly — Claude Code must be installed and logged in on the host.

### 1 · Install

```bash
git clone https://github.com/zaneven/CoBot.git
cd CoBot
./scripts/cobot.sh install
# copies config templates · installs deps · interactive setup · links the global `cobot` CLI
```

Install drops into an interactive setup — **fill in just three fields** to run, everything else stays at its default:

| Field | What it is | Where to get it |
|-------|------------|-----------------|
| **Telegram bot token** | the bot's token (required) | create a bot with [@BotFather](https://t.me/BotFather) |
| **Your Telegram user ID** | who may control the bot (required; comma-separated for several) | query [@userinfobot](https://t.me/userinfobot) |
| **Dev root directory** | whose subdirectories `/bind` can attach (defaults to the project's parent) | press Enter to accept the default |

When done, `.env` and `config.yaml` are written for you and the admin panel URL + key are printed. Then:

```bash
cobot start
```

> 💡 Re-run `npx tsx scripts/setup.ts` any time to change just those three; every other option lives in [Configuration](#configuration).

<details>
<summary>Manual alternative (skip the prompts)</summary>

```bash
cp .env.example .env
cp config.example.yaml config.yaml
npm install
npm rebuild better-sqlite3   # only if your Node version changed
```

Then fill in `config.yaml` (the bot token & allowed users live here, not `.env` — `setup` writes them here):

```yaml
telegram:
  botToken: "123456789:ABCdefGhi..."   # from @BotFather
  allowedUsers: [100123456]            # your Telegram user ID (comma-separated)

devRoots:
  - /Users/YOU/Develop          # immediate subdirectories become switchable projects

admin:
  enabled: true                # built-in Web Admin console
  port: 8085
  apiKey: "choose-a-secret"    # bearer token for the admin API
```
</details>

### 2 · Configure

The interactive install already fills in the three fields needed to start. To tune the model, quotas, approval mode, proxy and more, edit `.env` and `config.yaml` directly (env vars win) or use the built-in Web admin console — see [Configuration](#configuration) for the full reference.

### 3 · Run

```bash
cobot start     # background service, auto-detects proxy
cobot status    # process, proxy, recent logs
```

Foreground/dev mode: `npm run dev` (auto-reload on save).

### 4 · Send your first message

1. Open Telegram, message your bot.
2. `/projects` → tap a project.
3. Just send text — Claude Code answers, **streaming** into the chat.

> 🖼️ **Screenshot wanted:** a screenshot/GIF of a streamed reply here sells the project. Drop it at `docs/assets/demo.png` and replace this note.

---

## How it works

```
                      Telegram (long-poll)
                              │
                              ▼
                 ┌────────────────────────┐
                 │   grammY bot            │
                 │   auth gate (allowlist) │
                 └────────────┬───────────┘
                  /commands   │   plain text / photo / doc
                              ▼
                 ┌────────────────────────┐        per-chat Registry
                 │   SQLite store         │◀────── (FIFO queue,
                 │   bindings · tasks ·   │        active-run tracking)
                 │   cron · audit_logs    │
                 └────────────┬───────────┘
                              │ runTurn
                              ▼
                 ┌────────────────────────┐
                 │  Claude Agent SDK       │── streaming events ──▶ chat
                 │  (driver.ts)            │
                 └────────────┬───────────┘
                              ▼
                   local Claude Code session
              (started or resumed in the bound dir)

   node-cron ──▶ scheduled prompts dispatched to the same pipeline
```

Each Telegram chat binds to **one whitelisted project directory**. Every prompt starts (or resumes) a Claude Code session there, and the assistant's output streams back to the chat. A per-chat FIFO queue keeps tasks serial — `/stop` interrupts the running task, `/drop` clears the queue.

---

## Features

| | Feature | What it means |
| :--: | :--- | :--- |
| 🌊 | **Streaming replies** | Claude's output streams in via progressive Rich Message edits with full Markdown (tables, code, LaTeX), with HTML→plain fallback. |
| 🗂️ | **Session management** | List, resume, and switch between Claude Code sessions across all your projects. |
| 📋 | **Task queue** | FIFO per-chat queue. `/stop` interrupts the running task, `/drop` clears waiting ones. |
| ⏰ | **Scheduled tasks** | Cron-style prompts (`/cron`) dispatched to Claude Code — list/enable/disable/manage. |
| 🖼️ | **Multimodal input** | Send photos, PDFs, or text/code/log files alongside your prompt. |
| 🧩 | **Skill browser** | `/skills` lists available Skills; tap to fill the input bar. |
| ➕ | **Project creation** | Tap `➕ 新建项目` in `/projects` to scaffold a new dir with `git init`. |
| 📊 | **Context usage** | `/context` shows the last turn's context-window % with a visual bar. |
| ⌨️ | **Typing indicator** | Telegram "typing…" while the bot works. |
| 🛡️ | **Guardrails** | Turn cap, daily cost/token caps, audit log, interactive tool approval. |
| 🖥️ | **Web admin console** | Live tasks, costs, tool usage, logs, and config editing. |

---

## Commands

| Command | Description |
| :--- | :--- |
| `/projects` | List projects (tap to switch); `➕ 新建项目` at bottom |
| `/project <name>` | Switch active project by name |
| `/bind <path>` | Bind to an explicit whitelisted path |
| `/unbind` | Unbind this chat from its project |
| `/new` | Start a fresh Claude Code session |
| `/auto [off]` | Persistent auto-session mode |
| `/sessions [all]` | List sessions (tap to switch) |
| `/switch <id>` | Switch active session by ID |
| `/stop` | Interrupt the running task |
| `/tasks` | Active + recent tasks |
| `/queue` | Show queued prompts |
| `/drop` | Clear queued prompts |
| `/cron <schedule> \| <prompt>` | Schedule a task |
| `/cron list \| rm <id> \| enable <id> \| disable <id>` | Manage cron jobs |
| `/context` | Last turn's context-window usage (%) |
| `/skills` | Browse available Skills (tap to use) |
| `/approve auto\|interactive\|list\|clear <tool\|all>` | Tool-call approval mode |
| `/help` | Show this list |

**Keyboard buttons:** `Projects` `Sessions` `New` — `Stop` `Queue` `Tasks`

**Plain text**, **photo**, or **document** → sent straight to Claude Code (streaming).

---

## Configuration

CoBot reads **two layers**: environment variables (`.env`) for secrets/runtime, and `config.yaml` for structure/quotas. Env vars override the YAML where they overlap.

<details>
<summary><b>.env</b> — environment variables</summary>

```bash
# ---- Claude Code ----
CLAUDE_MODEL=                 # default model for spawned sessions (optional)
CLAUDE_PERMISSION_MODE=acceptEdits   # acceptEdits | bypassPermissions | default | plan
CLAUDE_TASK_TIMEOUT_MS=1800000        # per-task wall-clock cap (30m). 0 = off
CLAUDE_ALLOWED_TOOLS=                 # e.g. "Bash(git *),Edit,Read"
CLAUDE_ALLOW_DANGEROUS_SKIP_PERMISSIONS=false   # DANGEROUS
CLAUDE_MAX_TURNS=                     # cap agentic turns per task (default 50)

# ---- CoBot ----
# Telegram bot token & allowed users live in config.yaml (telegram.botToken /
# telegram.allowedUsers) — that's where `setup` writes them. These env vars
# still override the YAML if set, but setup no longer touches .env for them.
COBOT_DB_PATH=./data/cobot.db
COBOT_PROXY=http://127.0.0.1:10808    # outbound proxy to reach Telegram (optional)
LOG_LEVEL=info                          # trace | debug | info | warn | error

# ---- Hermes (optional backend, v1.5) ----
# HERMES_API_URL=http://127.0.0.1:8642
# HERMES_API_KEY=
```
</details>

<details>
<summary><b>config.yaml</b> — structure & quotas</summary>

```yaml
devRoots:                       # dirs whose immediate subdirectories are projects
  - /Users/YOU/Develop
projects:                       # extra whitelisted paths outside devRoots
  # - /Users/YOU/.hermes

telegram:
  botToken: ""                  # from @BotFather (env overrides)
  allowedUsers: [12345678]
  maxEditChars: 3500           # chars before appending a new chunk message
  pollTimeout: 30              # long-poll timeout (s)
  flushMs: 900                 # ms between streamed edits

approval:                      # interactive tool-call approval
  mode: auto                   # auto | interactive
  timeoutMs: 300000
  timeoutAction: allow         # allow | deny (when user doesn't respond)
  skipTools: [Read, LS, Glob, Grep, TodoWrite]   # never prompt (read-only)

defaults:
  maxTurns: 50                 # 0 = unlimited
  dailyCostCapUsd: 5.0         # per-chat daily ceiling (omit = none)
  dailyTokenCap: 200000        # per-chat daily token ceiling

admin:
  enabled: true
  host: "127.0.0.1"
  port: 8085
  apiKey: ""                   # bearer token for Admin API
```
</details>

---

## Safety & guardrails

CoBot is a headless agent with **local code-execution power**, so it ships guardrails to keep autonomous use **controllable and observable**.

- **User allowlist** — `telegram.allowedUsers` in `config.yaml` gates access (env `TELEGRAM_ALLOWED_USERS` overrides); unauthorized users are ignored.
- **Path whitelist** — `/bind` only accepts paths under `devRoots` / `projects` in `config.yaml`.
- **Per-task turn cap** — `DEFAULT_MAX_TURNS = 50` (override via `CLAUDE_MAX_TURNS` or `defaults.maxTurns`; `0` = unlimited).
- **Per-chat daily quota** — `dailyCostCapUsd` / `dailyTokenCap` reject new tasks once exceeded; resets at local midnight.
- **Audit log** — every task is recorded in the `audit_logs` table (chatId, prompt, tools, costUsd, duration, tokens, contextUsagePct, status) for cost accounting and forensics.
- **Interactive tool approval** — `/approve interactive` prompts before mutating tool calls; read-only tools in `skipTools` skip the prompt; tap ✅/❌/⭐ (always-allow). Mode + "always allow" rules persist in SQLite. Cron tasks always auto-approve. Default mode is `auto` (headless); set `COBOT_APPROVAL_TIMEOUT_ACTION=deny` to fail closed.
- **Wall-clock watchdog** — `CLAUDE_TASK_TIMEOUT_MS` aborts a hung task (e.g. one waiting on a prompt) so it can't block the chat.
- **Permission mode** — defaults to `acceptEdits` (headless auto-accept of file edits). `CLAUDE_ALLOW_DANGEROUS_SKIP_PERMISSIONS` is **off** by default.

---

## Web admin console

A built-in dashboard ships with CoBot (`admin.enabled: true`) at `http://127.0.0.1:8085`. Authenticate with the `admin.apiKey` bearer token. It gives you:

- **Overview** — uptime, active tasks, total tasks & success rate, cumulative cost & tokens, 7-day trend, tool-usage breakdown
- **Tasks & audit** — full history with cost, duration, status, prompt replay
- **Cron** — list / enable / disable / delete scheduled jobs
- **Bindings** — which chat is bound to which project
- **Config** — view/edit runtime config (raw YAML)
- **Live logs** — streaming teleprinter of bot output

> Design language: a dark "dispatch console" — amber (working), mint (healthy), violet (flagged) — with Space Grotesk + IBM Plex Mono. See [`src/admin/web/index.html`](./src/admin/web/index.html).

---

## Development

```bash
npm test                # 226 tests, Node built-in runner
npm run typecheck       # tsc --noEmit
npm run rebuild:native  # rebuild better-sqlite3 after a Node version change
npm run dev             # foreground, watch reload
```

> **CI note:** `better-sqlite3` is a native module. After `npm ci`, run `npm run rebuild:native` so the binary matches the CI Node version, or Store-backed tests fail with `ERR_DLOPEN_FAILED`.

### Project structure

```
src/
├── bot/        — grammY setup, commands, runs, streaming, media, approval
├── claude/     — Agent SDK driver + types + sessions (the ONLY SDK boundary)
├── registry/   — per-chat active-run tracking + FIFO queue
├── store/      — SQLite (better-sqlite3): bindings, tasks, cron, audit
├── scheduler/  — node-cron manager
├── admin/      — Web Admin HTTP server + static console
├── util/       — proxy, http, Telegram HTML formatting, logger
└── index.ts    — entry point
```

### Architecture constraints (for contributors)

- **SDK isolation** — `src/claude/driver.ts` is the *only* place that imports `@anthropic-ai/claude-agent-sdk`. Bot/registry layers talk to it solely via the `DriverEvent` union in `src/claude/types.ts`.
- **Non-blocking** — never `await` a long-running task inside a grammY update handler (it would block `/stop`). Use `void runOne(...)` / `submitInteractive`.
- **Streaming** — `TelegramStreamer` has two length controls: `maxEditChars` (new-message threshold, default 3500) and `TG_HARD_LIMIT = 32000` (Telegram's per-message cap). All sends are serialized to avoid edit rate-limits.

See [`AGENTS.md`](./AGENTS.md) for the full developer/agent guide and [`docs/development.md`](./docs/development.md).

---

## FAQ

<details>
<summary><b>The bot starts but never responds / "Telegram init timed out"</b></summary>

Your network can't reach `api.telegram.org`. Set `COBOT_PROXY` (or `HTTPS_PROXY`) in `.env`. On macOS, CoBot auto-detects the system proxy via `scutil --proxy`.
</details>

<details>
<summary><b>Tests fail with <code>ERR_DLOPEN_FAILED</code></b></summary>

The `better-sqlite3` native binary doesn't match your Node version. Run `npm run rebuild:native`.
</details>

<details>
<summary><b>409 Conflict on start</b></summary>

A previous bot instance is still polling. CoBot retries automatically; if it persists, `cobot stop` then `cobot start`.
</details>

<details>
<summary><b>How do I limit what Claude Code can do?</b></summary>

`CLAUDE_ALLOWED_TOOLS` restricts tools; `/approve interactive` prompts before mutating calls; `CLAUDE_MAX_TURNS` and the daily caps bound runaway spend. For the strictest posture, set `COBOT_APPROVAL_TIMEOUT_ACTION=deny`.
</details>

<details>
<summary><b>Does my code leave my machine?</b></summary>

No. CoBot drives your **local** Claude Code via the Agent SDK. Source files, prompts, and session state stay on the host. Only the chat traffic to Telegram traverses the network.
</details>

---

## Roadmap

- [ ] Docker image & docker-compose for one-command deploy
- [ ] Multi-user / team mode with per-user quotas
- [ ] Webhook transport alongside long-poll
- [ ] Plugin API for custom commands
- [ ] More providers (Cursor / local LLMs) behind the same driver boundary

> Have an idea? Open a [discussion](https://github.com/zaneven/CoBot/discussions) or an [issue](https://github.com/zaneven/CoBot/issues).

---

## Contributing

Contributions are welcome! Please read [`AGENTS.md`](./AGENTS.md) first — it documents the architecture constraints (SDK isolation, non-blocking handlers, streaming invariants) that every change must respect.

1. Fork & branch (`git checkout -b feat/my-feature`)
2. `npm test && npm run typecheck` before committing
3. Open a PR describing the change and linking any issue

By contributing, you agree that your contributions are licensed under the project's [MIT license](#license).

---

## License

[MIT](./LICENSE) © [zaneven](https://github.com/zaneven)

Claude Code and the Claude Agent SDK are products of Anthropic. CoBot is an independent, community project and is not affiliated with or endorsed by Anthropic.
