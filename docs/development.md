# Development Guide

## Setup

```bash
cp .env.example .env
cp config.example.yaml config.yaml
# Edit both files with your tokens and project paths.
npm install
```

## Running

```bash
npm run dev          # tsx watch — auto-reloads on changes
npm start            # single run without watch
```

## Testing

```bash
npm test             # all test suites
npm run typecheck    # tsc --noEmit type check
```

Individual test files:

```bash
npx tsx src/store/db.test.ts
npx tsx src/bot/streaming.test.ts
npx tsx src/registry/registry.test.ts
npx tsx src/claude/driver.test.ts
npx tsx src/bot/commands.test.ts
npx tsx src/bot/media.test.ts
npx tsx src/bot/runs.test.ts
npx tsx src/util/tgfmt.test.ts
```

Test framework: Node.js built-in `node:test` + `node:assert/strict`. Transform: `tsx`. No additional test libraries.

### Writing new tests

- Import only what you test. For classes that need a `Store` or `Api` dependency, pass a stub object satisfying the required interface, cast via `as unknown as Store` / `as any`.
- Tests using the SQLite layer use `:memory:` mode — `new Store(":memory:")`. Tables are cleared in `beforeEach`.
- Follow the pattern of existing tests: `test("descriptive name", () => { … })`.

## Proxy

On macOS with a proxy configured, the bot auto-detects it via `scutil --proxy`. Environment variables `COBOT_PROXY` / `HTTPS_PROXY` take precedence. The proxy is needed because grammY 1.45 uses `node-fetch` (not undici), so a `HttpsProxyAgent`/`SocksProxyAgent` must be passed into `baseFetchConfig.agent`.

## Config

| Env variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USERS` | — | Comma-separated Telegram user IDs |
| `CLAUDE_MODEL` | (unset, uses Claude Code default) | Model override for the SDK |
| `CLAUDE_PERMISSION_MODE` | `acceptEdits` | Tool permission mode |
| `CLAUDE_TASK_TIMEOUT_MS` | `600000` (10m) | Hard per-task timeout |
| `COBOT_PROXY` | — | Explicit proxy URL (bypasses auto-detect) |
| `LOG_LEVEL` | `info` | pino log level |

## Project structure

```
src/
  index.ts         — entry: config, store, bot startup
  config.ts        — YAML + env loading
  bot/
    bot.ts         — grammY Bot construction + command registration
    commands.ts    — all /slash command handlers
    runs.ts        — runOne/runTurn/submitInteractive (task lifecycle)
    streaming.ts   — TelegramStreamer (buffer/flush/edit-append)
    indicator.ts   — SilenceIndicator ("Still working…" heartbeat)
    media.ts       — Photo + document download/dispatch handlers
  claude/
    driver.ts      — runClaude (generator wrapper around Agent SDK)
    types.ts       — PromptInput, DriverEvent, MediaAttachment
    sessions.ts    — listProjectSessions / findSession (SDK wrapper)
  store/
    db.ts          — SQLite Store (bindings, tasks, cron_jobs)
  registry/
    registry.ts    — per-chat active run tracking + FIFO queue
  scheduler/
    cron.ts        — CronManager (node-cron scheduling + firing)
  util/
    proxy.ts       — auto-detect proxy / create agent
    http.ts        — download Buffer via proxy agent
    tgfmt.ts       — CommonMark → Telegram HTML converter
    logger.ts      — pino logger
```