# Commands

All commands registered in the bot's Telegram menu.

| Command | Description |
|---|---|
| `/projects` | List switchable projects (inline buttons, paginated 5×2). Tap to switch. |
| `/project <name>` | Switch active project by name. |
| `/bind <path>` | Bind this chat to an explicit whitelisted path. |
| `/unbind` | Unbind this chat from its project. |
| `/new` | Start a fresh Claude Code session. |
| `/auto [off]` | Toggle persistent auto-session mode. Once on, the session stays active forever until `/auto off`. |
| `/sessions [all]` | List local Claude Code sessions. Tap to switch. `all` shows across all projects. |
| `/switch <id>` | Switch the active session by its UUID (first 8 chars). |
| `/stop` | Interrupt the currently running Claude Code task. Also drops queued prompts. |
| `/tasks` | Show active + recent tasks for this chat. |
| `/queue` | Show the running task plus queued prompts. |
| `/drop` | Clear all queued prompts (the running task keeps going — use `/stop` for that). |
| `/cron <5-field cron> \| <prompt>` | Schedule a recurring Claude Code task. |
| `/cron list` | List all cron jobs for this chat with enabled/disabled status. |
| `/cron rm <id>` | Delete a cron job. |
| `/cron enable <id>` / `disable <id>` | Pause or resume a cron job without deleting it. |
| `/help` | Show this help. |

## Plain-text messages

Any text message (not a command) is treated as a prompt to Claude Code. If no task is running the prompt runs immediately; otherwise it's enqueued (FIFO).

## Rich media

Send a **photo** to pass it to Claude Code as an image attachment (JPEG/PNG/GIF/WebP). The caption becomes the text prompt.

Send a **document** — PDFs are sent as document blocks; image files are recognised by MIME type; text files (`.txt`, `.log`, etc.) are inlined (truncated at 200K chars). Binary files are rejected.

## Safety

- Only users listed in `TELEGRAM_ALLOWED_USERS` can control the bot.
- `/bind` only accepts paths whitelisted in `config.yaml` (`projects` or `devRoots`).
- Claude Code tools are auto-approved (personal bot on whitelisted dirs).