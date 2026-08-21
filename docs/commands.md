# Commands

All commands the bot registers in its Telegram menu. This table mirrors
`BOT_COMMANDS` in `src/bot/commands.ts` (the single source of truth that drives
both `setMyCommands` and `/help`), so if you change a command there, update it
here too.

## Slash commands

| Command | Description |
|---|---|
| `/start` | Show the welcome / command list. |
| `/projects` | List dev-root projects as inline buttons (paginated 5×2). Tap to switch the active project. |
| `/project <name>` | Switch the active project by name. |
| `/bind <path>` | Bind this chat to an explicit whitelisted path (must be under `projects` or a `devRoot`). |
| `/unbind` | Unbind this chat from its project. |
| `/new` | Start a fresh Claude Code session (drops the current session for the bound project). |
| `/auto [off]` | Toggle persistent auto-session mode. Once on, the session stays active until `/auto off` or a restart. |
| `/sessions [all]` | List local Claude Code sessions; tap to switch. `all` lists sessions across every project. |
| `/switch <id>` | Switch the active session by its UUID (first 8 chars). |
| `/stop` | Interrupt the currently running Claude Code task. Also drops queued prompts. |
| `/tasks` | Show active + recent tasks for this chat. |
| `/queue` | Show the running task plus queued prompts. |
| `/drop` | Clear all queued prompts (the running task keeps going — use `/stop` for that). |
| `/cron <5-field cron> \| <prompt>` | Schedule a recurring Claude Code task for the bound project. |
| `/cron list` | List all cron jobs for this chat with enabled/disabled status. |
| `/cron rm <id>` | Delete a cron job. |
| `/cron enable <id>` / `disable <id>` | Pause or resume a cron job without deleting it. |
| `/context` | Show the last turn's context-window usage % (in-memory; reset on restart). |
| `/skills` | Browse available skills as a paginated inline keyboard. Tap a skill to fill the input bar (inline-query mode), then type your query. |
| `/approve` | Show the current tool-approval mode and the per-chat "always-allow" tool list, with a toggle keyboard. |
| `/approve auto` / `interactive` | Switch the approval mode: `auto` auto-approves every tool call; `interactive` prompts for mutating tools (read-only tools in `skipTools` are still auto-allowed). |
| `/approve clear <tool\|all>` | Remove "always-allow" rules — a single tool, or `all` of them. |
| `/bot <start\|stop\|restart\|status\|install>` | Control the bot process. `--watch` re-enables hot-reload on `start`/`restart`. |
| `/restart` | Convenience alias for `/bot restart` — restart the bot, keeping the current launch mode. |
| `/help` | Show this help. |

## Plain-text messages

Any text message (not a command) is treated as a prompt to Claude Code. If no
task is running the prompt runs immediately; otherwise it's enqueued (FIFO).
A finished reply carries suggested next-step buttons when the model proposes
follow-up actions — tap to fire them as a new prompt.

## Rich media

- Send a **photo** to pass it to Claude Code as an image attachment
  (JPEG/PNG/GIF/WebP). The caption becomes the text prompt.
- Send a **document** — PDFs are sent as document blocks; image files are
  recognised by MIME type; text files (`.txt`, `.log`, etc.) are inlined
  (truncated at 200K chars). Binary files are rejected.

## Quick keyboard

A persistent reply keyboard sits above the input bar: `Projects` · `Sessions` ·
`New` / `Stop` · `Queue` · `Tasks`. Each maps to the matching command (Chinese
labels like `项目` / `会话` / `新建` also work).

## Safety

- Only users listed in `telegram.allowedUsers` (or `TELEGRAM_ALLOWED_USERS`) can
  control the bot.
- `/bind` only accepts paths whitelisted in `config.yaml` (`projects` or
  `devRoots`).
- In `auto` mode every tool call is approved automatically. In `interactive`
  mode, mutating tools surface an inline approval prompt you tap to allow or
  deny; read-only tools listed in `approval.skipTools` are always auto-allowed.
