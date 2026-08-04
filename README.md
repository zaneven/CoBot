# CoBot

A standalone TypeScript Telegram bot that **schedules and interacts with your locally-active Claude Code conversations** via the Claude Agent SDK. It runs alongside [Hermes](https://github.com/) (Nous Research) — Hermes is an *optional* backend, not required.

> CoBot uses its **own** Telegram bot token so it coexists with Hermes's built-in Telegram platform without polling conflicts.

## What it does

- **Bind a Telegram chat to a project** — each chat drives Claude Code in a whitelisted working directory.
- **Resume / switch local sessions** — list existing Claude Code sessions (`~/.claude/projects/...`) and continue them.
- **Concurrent multi-session management** — run several Claude Code sessions, view status, switch, interrupt.
- **Scheduled tasks** — cron-style prompts dispatched to Claude Code, results streamed back to Telegram.
- **Streaming replies** — assistant output is streamed back into the chat (editing/appending within Telegram limits).

## Quick start

```bash
cp .env.example .env        # set TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USERS
cp config.example.yaml config.yaml   # whitelist your project dirs
npm install
npm run dev
```

Then in Telegram: `/bind <path>`, `/new`, and just send text to talk to Claude Code.

## Architecture

```
Telegram (long-poll) ──► grammY bot ──► SessionRegistry ──► ClaudeCodeDriver (Agent SDK)
                              ▲                                   │
                              │                                   ▔▔▔ stream-json events
                          SQLite store                        (resume / new / abort)
                              │
                          node-cron ──► scheduled Claude Code tasks
                              │
                     (optional) HermesClient ──► Hermes api_server (delivery / memory)
```

Hermes's gateway runs **Hermes's own agent**, not Claude Code — so CoBot drives `claude` itself. Hermes is only used (optionally) for cross-platform delivery or shared memory, and only if you enable its `api_server`.

## Safety

- Only `TELEGRAM_ALLOWED_USERS` may control the bot.
- `/bind` only accepts paths whitelisted in `config.yaml`.
- Safe `permission-mode` by default; `--dangerously-skip-permissions` is off unless explicitly enabled.

See [`docs/`](docs/) for the command reference and development guide.
