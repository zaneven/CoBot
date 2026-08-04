# CoBot

A standalone TypeScript Telegram bot that drives your locally-active **Claude Code** conversations via the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk). It runs alongside Hermes (optional) without polling conflicts.

## Architecture

```
Telegram (long-poll) ──► grammY bot ──► Registry ──► Claude Agent SDK
                              ▲                  │
                              │          streaming events
                          SQLite store   (resume / new / abort)
                              │
                          node-cron ──► scheduled tasks to Telegram
```

- `src/bot/` — grammY handlers: commands, streaming, media, runs
- `src/claude/` — Claude Agent SDK driver + types
- `src/store/` — SQLite (better-sqlite3): bindings, tasks, cron jobs
- `src/registry/` — per-chat active-run tracking + FIFO queue
- `src/scheduler/` — node-cron scheduling manager
- `src/util/` — proxy, HTTP, Telegram HTML formatting, logging

Each chat is bound to one whitelisted project directory. Every prompt starts (or resumes) a Claude Code session in that directory, streaming the assistant output back to the chat.

## Quick start

```bash
cp .env.example .env          # set TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_USERS
cp config.example.yaml config.yaml  # whitelist your project dirs
npm install
npm run dev
```

In Telegram: `/projects` to pick a project, then just send text to start working.