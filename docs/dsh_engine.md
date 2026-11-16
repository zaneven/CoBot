# DeepSeek Harness (dsh) engine

CoBot can drive **DeepSeek Harness** — the `dsh` CLI from `@deepseek-ai/dsh` —
as a fourth engine alongside Claude Code, OpenCode and Antigravity CLI.

```bash
/engine dsh          # switch this chat
COBOT_BACKEND=dsh    # or make it the global default (env / config.yaml)
```

The engine is selected like any other: the chat's `/engine` pick wins, then
`backend` from config. `/models` lists the live catalog, run history and audit
rows are tagged `dsh`, and the dashboard shows `DeepSeek Harness`.

---

## How it is wired

`dsh` is a harness *launcher*, not a plain CLI. It exposes three programmable
surfaces; CoBot uses **ACP** (`dsh --profile acp`):

| Surface | Command | Why it is / is not used |
| --- | --- | --- |
| **ACP** (used) | `dsh --profile acp` | Standard ACP v1 over JSON-RPC stdio. Has `session/cancel` (so `/stop` works), advertises the full model catalog, and reports context occupancy. |
| SDK | `dsh --profile sdk` | Forwards every durable session event (incl. `todo/write`) and supports image blocks, but has **no cancel** — `/stop` could only kill the whole runtime. |
| Headless | `dsh --profile headless --json` | One-shot process per task; `--session-id` resumes, but the session's cwd is pinned to the launch directory. |

`src/dsh/` mirrors the other engines' layout:

| File | Role |
| --- | --- |
| `client.ts` | Long-lived ACP client: spawn, JSON-RPC framing, per-session update fan-out, permission answers, cancel. |
| `driver.ts` | `runDsh` generator → `DriverEvent`s; prompt/media flattening, model/effort selection, error mapping. |
| `models.ts` | `/models` catalog from ACP's advertised `model` config option. |
| `sessions.ts` | `/sessions` listing (ACP list + log-derived titles) and per-turn usage read-back. |

The runtime is a **single resident child process** shared by every chat: ACP
sessions carry their own `cwd`, so one runtime serves all projects. Boot costs
~1.5 s and the first catalog pull ~2.5 s — paid once per bot process, not per
task. Each run opens its own session (`session/new`) or adopts the chat's saved
id (`session/resume`).

---

## Behaviour worth knowing

**Streaming is per block, not per token.** ACP pushes committed chunks: tool
calls / results land immediately, but assistant text arrives in whole
`agent_message_chunk`s per round. The bot therefore renders a block at a time
instead of a character at a time. (The SDK surface has the same granularity —
only the headless profile streams live deltas, and only reasoning, to stderr.)

**No images / PDFs.** The shipped ACP profile advertises
`promptCapabilities.image: false`. Attached images are replaced by an explicit
notice in the prompt so the model asks for a text description instead of
silently pretending it saw the file. Text/code attachments are inlined normally.

**Sandbox is process-wide.** The runtime reads `DSH_PERMISSION_MODE` at spawn
and ACP exposes no knob to change it per session:

| Value | Effect |
| --- | --- |
| `workspace-write` (default) | Writes confined to the project + `/tmp`. Anything outside surfaces as a permission request → auto-approved (headless), or Telegram buttons when the chat's `/approve` mode is `interactive`. |
| `danger-full-access` | No confinement; dsh's `never` approval policy applies. |

Set `dsh.permissionMode` (or env `DSH_PERMISSION_MODE`) and restart the bot to
change it.

**Credentials.** The runtime resolves `DEEPSEEK_API_KEY` from its launch
environment (or `$DSH_HOME/.env`). A `dsh` account signed in through its Web /
Desktop surfaces is **also** usable — those routes appear in `/models` as the
`deepseek-account` group. Auth failures come back as friendly Chinese messages
(`MISSING_CREDENTIAL`, `401`, quota, 429).

**Session identity.** dsh ids look like `session-<uuid>` (headless) or a plain
uuid (ACP). Resume is rejected when the session was recorded in a different
`cwd`; CoBot catches that and starts a fresh session rather than failing the
task (e.g. a chat kept its id across a project switch).

**Accounting.** ACP reports context occupancy (`usage_update{used,size}` →
`contextUsagePct`) but not per-turn token counts, so `inputTokens` /
`outputTokens` are read back from the session log
(`$DSH_HOME/sessions/<cwd>/<id>/session.vN.jsonl.zstd`, multi-frame zstd).
`costUsd` is not reported by dsh, so dsh rows show tokens but no dollar figure.

---

## Configuration

```yaml
dsh:
  # path: "/opt/homebrew/bin/dsh"
  # model: "deepseek-official/deepseek-v4-pro"   # provider/model or bare model
  # models: []                                   # extra /models entries
  # effort: "high"                               # off | low | high | max
  # permissionMode: "workspace-write"            # see above
  autoApprove: true                              # headless permission answers
  timeoutMs: 600000
```

Env equivalents: `DSH_PATH`, `DSH_MODEL`, `DSH_MODELS`, `DSH_EFFORT`,
`DSH_PERMISSION_MODE`, `DSH_AUTO_APPROVE`, `DSH_TASK_TIMEOUT_MS`, `DSH_HOME`
(default `~/.dsh`; holds credentials and session logs).

`cobot start` forwards these into the launchd agent along with
`DEEPSEEK_API_KEY`.

---

## Operations

- `dsh` must be on `PATH` or set via `dsh.path`. `/engine dsh` probes it and
  says so when missing.
- The runtime's stderr is logged at debug level; a crash is logged as a warning
  and the next task respawns it automatically.
- `/stop`, timeouts and bot shutdown all go through ACP `session/cancel`, so
  the runtime (and other chats' sessions) stay alive.
- Sessions persist under `~/.dsh/sessions` and are shared with your other dsh
  surfaces (Desktop / Web); `/sessions` shows them, and titles come from the
  log's `session/title` event.

### Known limitations

- `dsh` is a 0.2.x RC — protocol shapes may drift; the client validates payloads
  defensively and logs what it cannot parse.
- No per-token streaming, no `costUsd`, no image input, no `additionalDirectories`
  (ACP rejects it), no todo/plan projection on the ACP wire (`todo_write`
  tool inputs are mapped, so the task panel still works).
- `/sessions` has no reliable timestamps on the ACP side; ordering uses the log
  mtime.
