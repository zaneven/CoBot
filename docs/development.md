# Development Guide

## Setup

```bash
cp .env.example .env           # Claude Code + log/proxy/db env vars
cp config.example.yaml config.yaml   # bot token, projects, approval, admin
# Edit config.yaml with your bot token + whitelisted project paths.
npm install
```

CoBot is **yaml-first**: `config.yaml` is the primary configuration. The `.env`
file mostly carries Claude Code SDK options, logging, the DB path, and proxy
settings. A few keys (`COBOT_APPROVAL_*`, `COBOT_ADMIN_*`, `COBOT_DAILY_*`) are
read from env **before** yaml — see the table below — so an env var will override
a yaml value for those. Everything else (bot token, allowed users, streaming
params, `showTraceText`) is yaml-only or yaml-first.

## Running

```bash
npm run dev          # tsx watch — auto-reloads on changes
npm start            # single run without watch
```

`/bot restart` from Telegram (or `/restart`) relaunches the bot in-process via
`scripts/cobot.sh`, carrying the current launch mode (`--watch` is kept).

## Testing

```bash
npm test             # all test suites (node --test)
npm run typecheck    # tsc --noEmit type check
```

Run a single suite:

```bash
node --import tsx --test src/bot/streaming.test.ts
node --import tsx --test src/config.test.ts
```

Test framework: Node.js built-in `node:test` + `node:assert/strict`. Transform:
`tsx`. No additional test libraries.

### Writing new tests

- Import only what you test. For classes that need a `Store` or `Api`
  dependency, pass a stub object satisfying the required interface, cast via
  `as unknown as Store` / `as any`.
- Tests using the SQLite layer use `:memory:` mode — `new Store(":memory:")`.
  Tables are cleared in `beforeEach`.
- Follow the pattern of existing tests: `test("descriptive name", () => { … })`.

## Proxy

On macOS with a proxy configured, the bot auto-detects it via `scutil --proxy`.
Environment variables `COBOT_PROXY` / `HTTPS_PROXY` take precedence (and
`COBOT_PROXY` bypasses the auto-detect). The proxy is needed because grammY
uses `node-fetch` (not undici), so a `HttpsProxyAgent`/`SocksProxyAgent` must
be passed into `baseFetchConfig.agent`.

## Configuration reference

Full yaml shape: see [`config.example.yaml`](../config.example.yaml).
Env vars (most are optional; defaults shown):

### Claude Code

| Env variable | Default | Purpose |
|---|---|---|
| `CLAUDE_MODEL` | (SDK default) | Model override for spawned Claude Code sessions |
| `CLAUDE_PERMISSION_MODE` | `acceptEdits` | `acceptEdits` / `bypassPermissions` / `default` / `plan` |
| `CLAUDE_TASK_TIMEOUT_MS` | `600000` (10m) | Hard per-task wall-clock timeout (ms); `0` disables the watchdog. Prefer `config.yaml` `defaults.taskTimeoutMs` |
| `CLAUDE_MAX_TURNS` | (SDK default) | Cap agentic turns per task; also `config.yaml` `defaults.maxTurns` |
| `CLAUDE_ALLOWED_TOOLS` | — | Comma-separated tool names to allow, e.g. `Bash(git *),Edit,Read` |
| `CLAUDE_ALLOW_DANGEROUS_SKIP_PERMISSIONS` | `false` | DANGEROUS: pass `--dangerously-skip-permissions` |

### CoBot core

| Env variable | Default | Purpose |
|---|---|---|
| `COBOT_DB_PATH` | `./data/cobot.db` | SQLite database path |
| `COBOT_PROXY` | — | Explicit proxy URL (bypasses macOS auto-detect) |
| `LOG_LEVEL` | `info` | pino level: `trace` / `debug` / `info` / `warn` / `error` |
| `NO_PRETTY` | — | Set to truthy to emit JSON logs instead of pino-pretty |
| `TELEGRAM_BOT_TOKEN` | — | Bot token fallback when `telegram.botToken` is unset in yaml |
| `TELEGRAM_ALLOWED_USERS` | — | Allowed-user-IDs fallback (comma-separated) when `telegram.allowedUsers` is unset |

### Approval (env overrides yaml `approval:`)

| Env variable | Default | Purpose |
|---|---|---|
| `COBOT_APPROVAL_MODE` | `auto` | `auto` (headless auto-approve) / `interactive` (prompt for mutating tools) |
| `COBOT_APPROVAL_TIMEOUT_MS` | `300000` | Per-request approval timeout (must be `< taskTimeoutMs`) |
| `COBOT_APPROVAL_TIMEOUT_ACTION` | `allow` | Decision when the user doesn't respond: `allow` / `deny` |
| `COBOT_APPROVAL_SKIP_TOOLS` | read-only set | Comma-separated tools never to prompt for |

### Defaults (env overrides yaml `defaults:`)

| Env variable | Default | Purpose |
|---|---|---|
| `COBOT_DAILY_COST_CAP_USD` | — | Per-chat daily USD ceiling |
| `COBOT_DAILY_TOKEN_CAP` | — | Per-chat daily token ceiling |

### Admin (env overrides yaml `admin:`)

| Env variable | Default | Purpose |
|---|---|---|
| `COBOT_ADMIN_ENABLED` | `true` | Start the Web Admin HTTP server on startup |
| `COBOT_ADMIN_HOST` | `127.0.0.1` | HTTP listen host |
| `COBOT_ADMIN_PORT` | `8085` | HTTP listen port |
| `COBOT_ADMIN_API_KEY` | — | Bearer secret for the Admin API (`admin.authEnabled` gates whether it's required) |

### Hermes (optional integration)

| Env variable | Default | Purpose |
|---|---|---|
| `HERMES_API_URL` | — | Hermes `api_server` URL (requires enabling it locally) |
| `HERMES_API_KEY` | — | Hermes API key (also usable as `${HERMES_API_KEY}` inline in yaml) |

## Project structure

```
src/
  index.ts         — entry: config, store, bot + admin startup, restart-notify
  config.ts        — yaml + env loading (see config.example.yaml for the shape)
  admin/
    server.ts      — Web Admin HTTP server + REST APIs (bindings, approval
                     rules, config live-edit, analytics, log control)
    web/index.html — the Admin SPA (bindings, config, tasks, cron, logs)
  bot/
    bot.ts         — grammY Bot construction + command/callback registration
    commands.ts    — slash command + callback handlers; BOT_COMMANDS (menu/help source)
    runs.ts       — task lifecycle: runOne/runTurn/submitInteractive/buildTraceReply
    streaming.ts  — TelegramStreamer: buffer/flush/edit-append + setContent + finalize
    approval.ts   — interactive tool-approval bridge (canUseTool → Telegram prompt)
    dashboard.ts  — TaskDashboard (live, in-place task card)
    indicator.ts  — SilenceIndicator ("Still working…" heartbeat)
    media.ts      — photo + document download/dispatch handlers
    nextActions.ts— suggested next-step buttons under a finished reply
    ctl.ts        — /bot start|stop|restart|status|install process control
  claude/
    driver.ts     — runClaude (generator wrapper around the Agent SDK)
    types.ts      — PromptInput, DriverEvent, MediaAttachment
    sessions.ts   — listProjectSessions / listAllSessions / findSession
  store/
    db.ts         — SQLite Store: bindings, running_tasks, cron_jobs, approval rules
  registry/
    registry.ts   — per-chat active-run tracking + FIFO queue + auto/context state
  scheduler/
    cron.ts       — CronManager (node-cron scheduling + firing)
  util/
    proxy.ts      — auto-detect proxy / create agent
    http.ts       — download Buffer via proxy agent
    tgfmt.ts      — CommonMark → Telegram HTML converter (mdToTelegramHtml)
    send.ts       — sendRichText / sendRichMessage wrappers + fallbacks
    mediaStore.ts — downloaded media caching
    duration.ts   — duration formatting helpers
    logger.ts     — pino logger (pino-pretty in dev, JSON when NO_PRETTY)
```
