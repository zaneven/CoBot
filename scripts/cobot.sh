#!/usr/bin/env bash
#
# CoBot Control Script
# Usage: ./scripts/cobot.sh [install|start|stop|restart|status|update|uninstall] [--yes]
#

set -e

# Resolve project root directory safely across symbolic links
SOURCE="${BASH_SOURCE[0]}"
while [ -h "${SOURCE}" ]; do
  DIR="$(cd -P "$(dirname "${SOURCE}")" && pwd)"
  SOURCE="$(readlink "${SOURCE}")"
  [[ ${SOURCE} != /* ]] && SOURCE="${DIR}/${SOURCE}"
done
SCRIPT_DIR="$(cd -P "$(dirname "${SOURCE}")" && pwd)"
ROOT_DIR="$(cd -P "${SCRIPT_DIR}/.." && pwd)"

PID_FILE="${ROOT_DIR}/data/cobot.pid"
LOG_FILE="${ROOT_DIR}/bot.log"
BACKUP_LOG_FILE="${ROOT_DIR}/bot.log.1"
DB_FILE="${ROOT_DIR}/data/cobot.db"
# Written by `__run` at startup: which launchd session the bot actually landed
# in. Surfaced by `status` — see the launchd block below for why it matters.
SESSION_FILE="${ROOT_DIR}/data/session"

# launchd agent identity. The bot is normally supervised as a GUI-session agent
# rather than a bare nohup'd process; see the "launchd (Aqua session)" block.
AGENT_LABEL="${COBOT_AGENT_LABEL:-com.cobot.agent}"
AGENT_PLIST="${HOME}/Library/LaunchAgents/${AGENT_LABEL}.plist"
GUI_DOMAIN="gui/$(id -u)"

# launchd appends to StandardOutPath, so bot.log is no longer truncated on every
# start (a crash loop used to overwrite its own evidence). Roll over instead.
LOG_MAX_BYTES=$((10 * 1024 * 1024))

# Ensure data directory exists
mkdir -p "${ROOT_DIR}/data"

cd "${ROOT_DIR}"

# ── Proxy Detection ──────────────────────────────────────────────────────────
detect_proxy() {
  if [ -n "${COBOT_PROXY:-}" ]; then
    echo "${COBOT_PROXY}"
    return 0
  fi
  if [ -n "${HTTPS_PROXY:-}" ]; then
    echo "${HTTPS_PROXY}"
    return 0
  fi
  if [ -n "${HTTP_PROXY:-}" ]; then
    echo "${HTTP_PROXY}"
    return 0
  fi
  # Fallback to macOS scutil detection
  if command -v scutil >/dev/null 2>&1; then
    local sc_out
    sc_out=$(scutil --proxy 2>/dev/null || true)
    if echo "${sc_out}" | grep -q "HTTPEnable : 1"; then
      local host port
      host=$(echo "${sc_out}" | awk '/HTTPProxy :/ {print $3}')
      port=$(echo "${sc_out}" | awk '/HTTPPort :/ {print $3}')
      if [ -n "${host}" ] && [ -n "${port}" ]; then
        echo "http://${host}:${port}"
        return 0
      fi
    fi
  fi
  echo ""
}

PROXY_URL=$(detect_proxy)

export_proxy_env() {
  if [ -n "${PROXY_URL}" ]; then
    export http_proxy="${PROXY_URL}"
    export https_proxy="${PROXY_URL}"
    export HTTP_PROXY="${PROXY_URL}"
    export HTTPS_PROXY="${PROXY_URL}"
  fi
}

# ── launchd (Aqua session) ───────────────────────────────────────────────────
#
# CoBot has to run inside the GUI/Aqua launchd session. macOS only releases
# login-keychain secrets to processes in that session; anything in the per-user
# "Background" session — an SSH login, or a job that opted into Background via
# `LimitLoadToSessionType` — gets errSecInteractionNotAllowed instead. The whole
# gh → git credential chain then collapses quietly:
#
#   security find-generic-password -s gh:github.com -w   → fails (secret denied)
#   gh auth git-credential get                           → returns nothing
#   git push                                             → fatal: could not read
#       Username for 'https://github.com': Device not configured
#
# Reads are denied but writes are not, so `gh auth login` "succeeds" in such a
# session while changing nothing — which is what makes this bug so slippery. The
# durable fix is therefore to start the bot *in* Aqua, not to move the token
# somewhere less protected.
#
# `start` bootstraps this LaunchAgent instead of nohup-ing the bot. A job in
# gui/<uid> is started from that session regardless of who asked, so `/restart`
# from Telegram — which spawns this script from inside the bot itself — also
# lands the replacement instance in Aqua, self-healing a bot that was started
# over SSH.

have_launchd() {
  [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1
}

agent_loaded() {
  launchctl print "${GUI_DOMAIN}/${AGENT_LABEL}" >/dev/null 2>&1
}

agent_pid_of() {
  agent_loaded || return 0
  launchctl print "${GUI_DOMAIN}/${AGENT_LABEL}" 2>/dev/null \
    | awk '/^[[:space:]]*pid = /{print $3; exit}'
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Keep bot.log bounded now that launchd appends to it instead of truncating.
rotate_log() {
  [ -f "${LOG_FILE}" ] || return 0
  local size
  size=$(wc -c < "${LOG_FILE}" 2>/dev/null || echo 0)
  [ "${size:-0}" -gt "${LOG_MAX_BYTES}" ] || return 0
  mv -f "${LOG_FILE}" "${BACKUP_LOG_FILE}" 2>/dev/null || true
}

write_agent_plist() {
  mkdir -p "$(dirname "${AGENT_PLIST}")"

  # launchd hands a job a bare /usr/bin:/bin:/usr/sbin:/sbin — no nvm, no
  # homebrew. Bake in the directory of the node running THIS script, since that
  # is where npx/tsx resolve from.
  local node_dir=""
  if command -v node >/dev/null 2>&1; then
    node_dir="$(cd "$(dirname "$(command -v node)")" && pwd)"
  fi
  local path_env="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  [ -n "${node_dir}" ] && path_env="${node_dir}:${path_env}"

  # launchd does not inherit the calling shell's environment, so every variable
  # CoBot reads has to be declared here. This is a deliberate allowlist rather
  # than a dump of `env`: the plist sits at a predictable path, and forwarding
  # everything would copy unrelated secrets into it.
  local kv=""
  emit_env() {
    [ -z "$2" ] && return 0
    kv="${kv}        <key>$1</key>
        <string>$(xml_escape "$2")</string>
"
  }
  emit_env PATH "${path_env}"
  emit_env COBOT_WATCH "${COBOT_WATCH:-0}"
  emit_env COBOT_KEEPALIVE "${COBOT_KEEPALIVE:-0}"
  emit_env COBOT_NOTIFY_CID "${COBOT_NOTIFY_CID:-}"
  if [ -n "${PROXY_URL}" ]; then
    emit_env COBOT_PROXY "${PROXY_URL}"
    emit_env HTTPS_PROXY "${PROXY_URL}"
    emit_env HTTP_PROXY "${PROXY_URL}"
  fi
  local name val
  for name in LOG_LEVEL NO_PRETTY COBOT_ADMIN_ENABLED COBOT_ADMIN_PORT \
              COBOT_ADMIN_HOST COBOT_BACKEND COBOT_DB_PATH COBOT_ALLOWED_ROOT \
              CLAUDE_PATH CLAUDE_MODEL CLAUDE_PERMISSION_MODE CLAUDE_MAX_TURNS \
              CLAUDE_TASK_TIMEOUT_MS CLAUDE_ALLOW_DANGEROUS_SKIP_PERMISSIONS \
              OPENCODE_PATH OPENCODE_AUTO_APPROVE OPENCODE_TASK_TIMEOUT_MS \
              AGY_PATH AGY_DB_PATH AGY_AUTO_APPROVE AGY_TASK_TIMEOUT_MS \
              HERMES_API_KEY HERMES_API_URL; do
    val="${!name}"
    emit_env "${name}" "${val}"
  done

  # Optional crash supervision. Off by default: it changes stop/start semantics
  # (a crash resurrection can mask a bad config), and a plain agent already
  # matches the previous nohup behaviour.
  local keep=""
  if [ "${COBOT_KEEPALIVE:-0}" = "1" ]; then
    keep="    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
"
  fi

  cat > "${AGENT_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$(xml_escape "${AGENT_LABEL}")</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$(xml_escape "${ROOT_DIR}/scripts/cobot.sh")</string>
        <string>__run</string>
    </array>

    <!-- The point of this agent. Aqua is the only launchd session macOS hands
         login-keychain secrets to; a Background job gets
         errSecInteractionNotAllowed, which silently breaks gh/git pushes. -->
    <key>LimitLoadToSessionType</key>
    <array>
        <string>Aqua</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>WorkingDirectory</key>
    <string>$(xml_escape "${ROOT_DIR}")</string>

    <key>StandardOutPath</key>
    <string>$(xml_escape "${LOG_FILE}")</string>
    <key>StandardErrorPath</key>
    <string>$(xml_escape "${LOG_FILE}")</string>

    <key>EnvironmentVariables</key>
    <dict>
${kv}    </dict>
${keep}</dict>
</plist>
PLIST
  # 0600: the plist can carry a proxy URL and (if the caller exported them)
  # API keys. launchd is happy with an owner-only plist.
  chmod 600 "${AGENT_PLIST}"
}

# Load or reload the agent. Prefers `kickstart -k` when the job is already
# bootstrapped, so a restart never depends on `bootout` succeeding from a
# non-GUI session — which matters because /restart runs this script from inside
# the bot, and the bot itself may still be in the Background session.
load_agent() {
  # `stop` disables the service so it stays down across logins — undo that
  # before (re)loading, or bootstrap would silently refuse to start it.
  launchctl enable "${GUI_DOMAIN}/${AGENT_LABEL}" >/dev/null 2>&1 || true

  if agent_loaded; then
    if launchctl kickstart -k "${GUI_DOMAIN}/${AGENT_LABEL}" >/dev/null 2>&1; then
      return 0
    fi
    launchctl bootout "${GUI_DOMAIN}/${AGENT_LABEL}" >/dev/null 2>&1 || true
    sleep 1
  fi
  launchctl bootstrap "${GUI_DOMAIN}" "${AGENT_PLIST}" >/dev/null 2>&1
}

# ── Process Helpers ──────────────────────────────────────────────────────────
get_running_pids() {
  # macOS `pgrep -f` can silently return NOTHING for CoBot's node/tsx tree (it
  # can't always read argv for detached/launchd-reparented processes) even while
  # the bot is plainly running — `ps` sees it fine. In sandboxed/container envs
  # the reverse holds (ps is restricted, pgrep works). Take the UNION of both so
  # the bot is always detected, then emit unique numeric PIDs only.
  {
    if command -v pgrep >/dev/null 2>&1; then
      pgrep -f "(tsx|node).*src/index\.ts" 2>/dev/null || true
    fi
    ps aux 2>/dev/null | grep -E "(tsx|node).*src/index\.ts" | grep -v grep | awk '{print $2}' || true
  } | tr -s '[:space:]' '\n' | grep -E '^[0-9]+$' | sort -n -u
}

# Best-effort SIGKILL of every CoBot process, retrying until none remain (or a
# 12s budget elapses). Always returns 0 so `set -e` never aborts the script.
# This is what makes `/restart` reliable: it guarantees the previous instance
# is fully gone before a new one is launched, avoiding the "already running"
# early-exit that previously left the bot dead after a restart.
kill_all_cobot() {
  local count=0
  while [ ${count} -lt 12 ]; do
    local pids
    pids=$(get_running_pids)
    if [ -z "${pids}" ]; then
      return 0
    fi
    for pid in ${pids}; do
      kill -9 "${pid}" 2>/dev/null || true
    done
    sleep 1
    count=$((count + 1))
  done
  return 0
}

get_admin_url() {
  local port=""
  local host=""

  # 1. Try to extract from recent startup logs
  if [ -f "${LOG_FILE}" ]; then
    port=$(tail -n 50 "${LOG_FILE}" 2>/dev/null | grep -E "Admin Web Server started" -A 4 | awk '/port:/ {print $2}' | tr -d '"\r' | tail -n 1)
    host=$(tail -n 50 "${LOG_FILE}" 2>/dev/null | grep -E "Admin Web Server started" -A 4 | awk '/host:/ {print $2}' | tr -d '"\r' | tail -n 1)
  fi

  # 2. Fall back to environment variables
  if [ -z "${port}" ]; then
    port="${COBOT_ADMIN_PORT:-}"
    host="${COBOT_ADMIN_HOST:-127.0.0.1}"
  fi

  # 3. Fall back to config.yaml
  if [ -z "${port}" ] && [ -f "${ROOT_DIR}/config.yaml" ]; then
    port=$(awk '/^admin:/,/^([a-zA-Z]|$)/ {if ($1 == "port:") print $2}' "${ROOT_DIR}/config.yaml" 2>/dev/null | head -n 1)
    local yaml_host
    yaml_host=$(awk '/^admin:/,/^([a-zA-Z]|$)/ {if ($1 == "host:") print $2}' "${ROOT_DIR}/config.yaml" 2>/dev/null | head -n 1)
    [ -n "${yaml_host}" ] && host="${yaml_host}"
  fi

  port="${port:-8085}"
  host="${host:-127.0.0.1}"
  [ "${host}" = "0.0.0.0" ] && host="127.0.0.1"

  echo "http://${host}:${port}"
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_install() {
  echo "=========================================="
  echo " Installing CoBot Dependencies & CLI"
  echo "=========================================="

  # 1. Config files check
  if [ ! -f "${ROOT_DIR}/config.yaml" ] && [ -f "${ROOT_DIR}/config.example.yaml" ]; then
    echo "[+] Creating config.yaml from config.example.yaml..."
    cp "${ROOT_DIR}/config.example.yaml" "${ROOT_DIR}/config.yaml"
  fi

  if [ ! -f "${ROOT_DIR}/.env" ] && [ -f "${ROOT_DIR}/.env.example" ]; then
    echo "[+] Creating .env from .env.example..."
    cp "${ROOT_DIR}/.env.example" "${ROOT_DIR}/.env"
  fi

  # 2. Install npm packages
  export_proxy_env
  echo "[+] Installing npm dependencies..."
  # --no-fund/--no-audit silence the funding & vulnerability notices (not
  # actionable for a first-time installer); --loglevel=error hides deprecation
  # warnings and the "added N packages" summary so the log stays focused.
  # Real install errors still surface to stderr.
  npm install --no-fund --no-audit --loglevel=error

  # 3. Interactive configuration — only the essentials; everything else keeps
  #    its default so the bot can start right after install. Skipped in
  #    non-interactive shells (CI/piped stdin) so `install` stays scriptable.
  local setup_ok=0
  if [ -t 0 ]; then
    echo "[+] Interactive configuration..."
    if npx tsx scripts/setup.ts; then
      setup_ok=1
    else
      echo "[!] Setup skipped — edit .env and config.yaml manually before starting."
    fi
  else
    echo "[!] Non-interactive shell detected — skipping setup. Run 'npx tsx scripts/setup.ts' to configure."
  fi

  # 4. Typecheck
  echo "[+] Running typecheck..."
  # --silent drops npm's `> cobot@… typecheck` / `> tsc --noEmit` banner lines;
  # tsc prints nothing on success and its errors still surface on failure.
  npm run typecheck --silent

  # 5. Register global 'cobot' command
  echo "[+] Registering global 'cobot' CLI command..."
  # Fully silenced: `npm link` prints "up to date, audited 3 packages…" noise
  # that's useless here. Our own echo above is the user-facing confirmation; a
  # link failure is non-fatal (we fall back to direct symlinks below).
  npm link --force --no-fund --no-audit --silent >/dev/null 2>&1 || true

  # Also attempt to create direct symlink in system/user PATH
  local target_bin=""
  if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
    target_bin="/usr/local/bin/cobot"
  elif [ -d "${HOME}/.local/bin" ]; then
    target_bin="${HOME}/.local/bin/cobot"
  elif [ -d "${HOME}/bin" ]; then
    target_bin="${HOME}/bin/cobot"
  fi

  if [ -n "${target_bin}" ]; then
    ln -sf "${ROOT_DIR}/scripts/cobot.sh" "${target_bin}"
    echo "[+] Symlink created: ${target_bin} -> ${ROOT_DIR}/scripts/cobot.sh"
  fi

  echo "=========================================="
  echo " CoBot Install Complete!"
  echo " Global 'cobot' CLI registered. Commands:"
  echo "   cobot start     - Start CoBot service"
  echo "   cobot stop      - Stop CoBot service"
  echo "   cobot restart   - Restart CoBot service"
  echo "   cobot status    - View CoBot status & logs"
  echo "   cobot update    - Pull latest source & restart"
  echo "   cobot uninstall - Remove CoBot (CLI + deps + data + config)"
  echo "=========================================="

  # 6. Auto-start the bot so a fresh install is ready to use immediately — but
  #    only when setup actually succeeded (interactive shell, config filled
  #    in); otherwise the bot would fail to start without a token. A launch
  #    failure is caught so a bot that won't start doesn't mask a successful
  #    install (the install itself still reports success).
  if [ "${setup_ok}" = "1" ]; then
    echo ""
    echo "[+] Starting CoBot..."
    cmd_start || echo "[!] Auto-start did not succeed. Run 'cobot start' after fixing the issue (see ${LOG_FILE})."
  else
    echo ""
    echo "[i] Fill in config.yaml, then run 'cobot start'."
  fi
}

cmd_stop() {
  echo "=========================================="
  echo " Stopping CoBot"
  echo "=========================================="

  # Unload the agent first: it supervises the bot, so killing the process
  # behind launchd's back would just look like a crash to it.
  if have_launchd; then
    if agent_loaded; then
      echo "[+] Unloading launchd agent ${AGENT_LABEL}..."
      launchctl bootout "${GUI_DOMAIN}/${AGENT_LABEL}" >/dev/null 2>&1 || true
    fi
    # Keep it down across logins. The plist stays in ~/Library/LaunchAgents, so
    # without this `stop` would quietly undo itself the next time you log in.
    # `start` re-enables before bootstrapping.
    launchctl disable "${GUI_DOMAIN}/${AGENT_LABEL}" >/dev/null 2>&1 || true
  fi

  if [ -f "${PID_FILE}" ]; then
    local saved_pid
    saved_pid=$(cat "${PID_FILE}" 2>/dev/null || true)
    if [ -n "${saved_pid}" ] && kill -0 "${saved_pid}" 2>/dev/null; then
      echo "[+] Sending SIGTERM to recorded PID ${saved_pid}..."
      kill -15 "${saved_pid}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}"
  fi

  # Graceful shutdown window, then a hard kill loop until nothing remains.
  echo "[+] Waiting for graceful shutdown..."
  sleep 2
  kill_all_cobot

  # Clean stale SQLite task locks if database exists
  if [ -f "${DB_FILE}" ] && command -v sqlite3 >/dev/null 2>&1; then
    echo "[+] Cleaning lingering SQLite running_tasks state..."
    sqlite3 "${DB_FILE}" "UPDATE running_tasks SET status='aborted' WHERE status='running';" 2>/dev/null || true
  fi

  echo "[+] CoBot stopped successfully."
}

cmd_start() {
  echo "=========================================="
  echo " Starting CoBot"
  echo "=========================================="

  export_proxy_env

  # Check & rebuild native bindings if node version changed
  if ! node --input-type=module -e "import Database from 'better-sqlite3'; new Database(':memory:');" >/dev/null 2>&1; then
    echo "[!] SQLite native bindings failed or mismatched. Rebuilding for current Node.js runtime..."
    npm rebuild better-sqlite3
  fi

  # Decide tsx launch mode. COBOT_WATCH=1 → hot-reload (tsx watch), so a Telegram
  # /restart keeps the dev experience. The flag is exported so the spawned bot
  # (and any future restart) inherits it.
  if [ "${COBOT_WATCH:-}" = "1" ] || [ "${COBOT_WATCH:-}" = "true" ] || [ "${COBOT_WATCH:-}" = "yes" ]; then
    TSX_CMD="npx tsx watch"
  else
    TSX_CMD="npx tsx"
  fi
  export COBOT_WATCH="${COBOT_WATCH:-0}"

  if [ -n "${PROXY_URL}" ]; then
    echo "[+] Proxy detected & enabled: ${PROXY_URL}"
  else
    # No shell-level reachability probe here. The bot itself probes
    # api.telegram.org at startup (src/util/proxy.ts) and logs the real
    # result — visible in the startup log preview below. A second probe here
    # used to race that check: its 6s timeout produced false "Cannot reach
    # Telegram" alarms even on reachable networks (a cold DNS + TLS handshake
    # can exceed the budget), which then contradicted the bot's own
    # "reachable" log line. The bot's authoritative probe is the source of
    # truth — trust it instead of re-probing (and possibly mis-probing) here.
    echo "[+] No proxy configured (direct connection). Telegram reachability is probed at startup — see the log preview below."
    echo "    If Telegram is blocked on this network, set COBOT_PROXY in .env (e.g. http://127.0.0.1:7890)."
  fi

  echo "[+] Launch mode: ${TSX_CMD}"

  # Preferred path: hand the bot to launchd in the Aqua session. See the
  # "launchd (Aqua session)" block near the top for why the session matters.
  if have_launchd; then
    # Reap anything an earlier nohup launch left behind — a stray poller would
    # fight the new instance for Telegram's single long-poll slot (409 Conflict).
    kill_all_cobot || true
    rotate_log
    write_agent_plist
    echo "[+] Starting launchd agent ${AGENT_LABEL} (session: Aqua)..."

    if load_agent; then
      # Wait 5 seconds to verify full startup (including Telegram getMe & command menu registration)
      sleep 5

      echo "------------------------------------------"
      echo " Startup Log Preview:"
      echo "------------------------------------------"
      tail -n 15 "${LOG_FILE}" || true
      echo "------------------------------------------"

      local agent_pid
      agent_pid=$(agent_pid_of)
      if [ -n "${agent_pid}" ]; then
        echo "${agent_pid}" > "${PID_FILE}"
        echo "[+] CoBot is running and ready (PID: ${agent_pid}, ${GUI_DOMAIN}/${AGENT_LABEL})."
        echo "[+] Admin: $(get_admin_url)"
        return 0
      fi
      echo "[!] launchd loaded ${AGENT_LABEL} but no process is running. Check ${LOG_FILE}."
      return 1
    fi

    echo "[!] Could not bootstrap the launchd agent — no reachable GUI session for uid $(id -u)?"
    echo "    Falling back to a plain background process."
  fi

  # Fallback: a bare background process, no launchd. This works on hosts with no
  # GUI session, but if this shell IS an SSH/Background session the bot inherits
  # it and can no longer read the login keychain — git/gh pushes from the bot
  # will fail until it is restarted from a GUI terminal.
  echo "[!] Starting without launchd — login-keychain credentials may be unavailable"
  echo "    to the bot if this shell is an SSH/Background session."
  kill_all_cobot || true
  echo "[+] Launching CoBot in background..."
  nohup ${TSX_CMD} src/index.ts > "${LOG_FILE}" 2>&1 &
  local new_pid=$!

  echo "${new_pid}" > "${PID_FILE}"
  echo "[+] CoBot process spawned (PID: ${new_pid}). Logging to bot.log"

  # Wait 5 seconds to verify full startup (including Telegram getMe & command menu registration)
  sleep 5

  echo "------------------------------------------"
  echo " Startup Log Preview:"
  echo "------------------------------------------"
  tail -n 15 "${LOG_FILE}" || true
  echo "------------------------------------------"

  if get_running_pids >/dev/null 2>&1; then
    echo "[+] CoBot is running and ready."
    echo "[+] Admin: $(get_admin_url)"
  else
    echo "[!] CoBot failed to start. Check ${LOG_FILE} for errors."
    return 1
  fi
}

# Internal foreground entry point — the command the launchd agent's
# ProgramArguments invoke. Not part of the public CLI.
cmd_run() {
  cd "${ROOT_DIR}"
  export_proxy_env

  # Stamp (and shout about) the launchd session we actually landed in. This one
  # fact is what explains "the bot can't push any more": if it says Background,
  # macOS is withholding the login keychain and no amount of `gh auth login`
  # will help, because writes to the keychain are allowed while reads are not.
  local mgr="unknown"
  command -v launchctl >/dev/null 2>&1 && mgr="$(launchctl managername 2>/dev/null || echo unknown)"
  echo "${mgr}" > "${SESSION_FILE}" 2>/dev/null || true
  if [ "${mgr}" != "Aqua" ]; then
    echo "[!] CoBot started in the '${mgr}' launchd session, not Aqua."
    echo "    Login-keychain reads will fail here, so gh/git pushes from the bot"
    echo "    will report \"could not read Username for 'https://github.com'\"."
    echo "    Fix: run 'cobot stop && cobot start' from a local GUI terminal."
  fi

  if [ "${COBOT_WATCH:-}" = "1" ] || [ "${COBOT_WATCH:-}" = "true" ] || [ "${COBOT_WATCH:-}" = "yes" ]; then
    exec npx tsx watch src/index.ts
  fi
  exec npx tsx src/index.ts
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  echo "=========================================="
  echo " CoBot Status"
  echo "=========================================="

  local pids
  pids=$(get_running_pids)

  if [ -n "${pids}" ]; then
    echo "[Status]: RUNNING (PID: ${pids})"
    if [ -n "${PROXY_URL}" ]; then
      echo "[Proxy]:  ${PROXY_URL}"
    else
      echo "[Proxy]:  Direct (None)"
    fi
    echo "[Admin]:  $(get_admin_url)"
  else
    echo "[Status]: STOPPED"
  fi

  # launchd supervision state. A job in gui/<uid> is what keeps the bot inside
  # the Aqua session.
  if have_launchd; then
    if agent_loaded; then
      echo "[launchd]: ${AGENT_LABEL} loaded in ${GUI_DOMAIN} (LimitLoadToSessionType=Aqua)"
    else
      echo "[launchd]: ${AGENT_LABEL} not loaded (bare background process?)"
    fi
  fi

  # Session the running instance actually reported at startup (stamped by
  # `__run`). Anything other than Aqua means macOS is withholding the login
  # keychain: gh/git pushes from the bot WILL fail, whatever `gh auth status`
  # says in your own terminal.
  if [ -f "${SESSION_FILE}" ]; then
    local session
    session=$(cat "${SESSION_FILE}" 2>/dev/null || echo "?")
    if [ "${session}" = "Aqua" ]; then
      echo "[Session]: ${session} (login keychain accessible)"
    else
      echo "[Session]: ${session} — WARNING: keychain inaccessible, git/gh pushes will fail"
    fi
  fi

  if [ -f "${LOG_FILE}" ]; then
    echo "------------------------------------------"
    echo " Recent Logs (tail bot.log):"
    echo "------------------------------------------"
    tail -n 10 "${LOG_FILE}"
  fi
}

cmd_update() {
  echo "=========================================="
  echo " Updating CoBot"
  echo "=========================================="

  # 'update' pulls the latest source from the remote, refreshes deps, and
  # restarts. Only works on a git clone of the source repo (a tarball/zip
  # install can't self-update). All safety checks run while the bot is still
  # up; the bot is only stopped once a clean fast-forward is guaranteed, so a
  # failed/aborted update never strands the running instance.
  if ! git -C "${ROOT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "[!] ${ROOT_DIR} is not a git repository — 'update' needs a git clone of the source."
    return 1
  fi

  export_proxy_env

  local branch upstream
  branch=$(git -C "${ROOT_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if [ -z "${branch}" ] || [ "${branch}" = "HEAD" ]; then
    echo "[!] Detached HEAD — checkout a branch to track updates (e.g. git -C ${ROOT_DIR} checkout main)."
    return 1
  fi
  upstream=$(git -C "${ROOT_DIR}" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo "")
  if [ -z "${upstream}" ]; then
    echo "[!] Branch '${branch}' has no upstream configured."
    echo "    Set it with: git -C ${ROOT_DIR} branch --set-upstream-to=origin/${branch}"
    return 1
  fi

  echo "[+] Fetching ${upstream}..."
  if ! git -C "${ROOT_DIR}" fetch --quiet origin 2>/dev/null; then
    echo "[!] git fetch failed — check network/proxy reachability to the remote."
    return 1
  fi

  # behind = remote commits not yet on local (what we'd pull in).
  # ahead   = local commits not on remote (divergence — blocks a fast-forward).
  local behind ahead
  behind=$(git -C "${ROOT_DIR}" rev-list --count 'HEAD..@{upstream}' 2>/dev/null || echo 0)
  ahead=$(git -C "${ROOT_DIR}" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)

  if [ "${behind}" = "0" ]; then
    if [ "${ahead}" = "0" ]; then
      echo "[✓] Already up to date."
    else
      echo "[✓] Already up to date (${ahead} local commit(s) ahead of ${upstream} — not pushed)."
    fi
    # Nothing to pull — don't touch the running bot.
    return 0
  fi

  if [ "${ahead}" != "0" ]; then
    echo "[!] Local branch has ${ahead} commit(s) not on ${upstream} — cannot fast-forward."
    echo "    Rebase or merge manually, then re-run 'cobot update'."
    return 1
  fi

  # A dirty working tree would clash with the pull. config.yaml/.env are
  # gitignored so they never show here; only tracked source edits do. Abort
  # with the files listed so the user commits/stashes knowingly — auto-stashing
  # risks losing work.
  local dirty
  dirty=$(git -C "${ROOT_DIR}" status --porcelain 2>/dev/null | grep -vE '^\?\?' || true)
  if [ -n "${dirty}" ]; then
    echo "[!] Uncommitted local changes would conflict with the update:"
    echo "${dirty}" | sed 's/^/    /'
    echo "    Commit or stash them (git -C ${ROOT_DIR} stash), then re-run 'cobot update'."
    return 1
  fi

  # Pre-checks passed (clean tree, fast-forwardable) — safe to stop now.
  echo "[+] ${behind} new commit(s) behind ${upstream}. Stopping CoBot to update safely..."
  cmd_stop >/dev/null 2>&1 || true

  # --ff-only: never create a merge commit; if the pre-checks somehow missed a
  # divergence (e.g. a push race), fail loudly instead of silently merging. The
  # fetch above already refreshed origin/<branch>, so merge against @{upstream}
  # with no second network round-trip.
  if ! git -C "${ROOT_DIR}" merge --ff-only --quiet '@{upstream}' 2>/dev/null; then
    echo "[!] Fast-forward failed (likely a divergence race). CoBot is stopped."
    echo "    Resolve in ${ROOT_DIR}, then run 'cobot start'."
    return 1
  fi

  echo "[+] Updating dependencies..."
  # Use `npm ci` (not `npm install`) for self-updates: it installs exactly
  # what package-lock.json pins and NEVER rewrites the lockfile. `npm install`
  # can regenerate package-lock.json (npm version drift, platform-specific
  # optional deps like better-sqlite3/esbuild), leaving a dirty working tree
  # that then blocks the next 'cobot update' with "Uncommitted local changes".
  if ! npm ci --no-fund --no-audit --loglevel=error; then
    echo "[!] npm ci failed — CoBot is stopped. Fix deps in ${ROOT_DIR}, then run 'cobot start'."
    return 1
  fi

  # Typecheck the freshly-pulled source so a broken upstream is caught before
  # restart rather than crashing at runtime. Non-fatal: a type error shouldn't
  # strand the bot — we still start, just warn and point at the details.
  echo "[+] Typechecking updated source..."
  if ! npm run typecheck --silent >/dev/null 2>&1; then
    echo "[!] Typecheck failed after update — the bot will still start, but the source may have issues."
    echo "    Run 'npm run typecheck' in ${ROOT_DIR} for details."
  fi

  echo "[+] Restarting CoBot..."
  cmd_start
}

cmd_uninstall() {
  local confirm="${1:-}"

  echo "=========================================="
  echo " Uninstalling CoBot"
  echo "=========================================="

  # Confirm before deleting config (holds the bot token) + data. In a
  # non-interactive shell require an explicit --yes so CI/piped runs can't
  # silently wipe a working install.
  if [ "${confirm}" != "--yes" ] && [ "${confirm}" != "-y" ]; then
    if [ -t 0 ]; then
      echo "This will stop CoBot, remove the global 'cobot' CLI, and delete:"
      echo "  node_modules · dist · data/ · *.log · config.yaml · .env"
      echo "The source repo at ${ROOT_DIR} is kept."
      printf "Proceed? [y/N] "
      local answer
      read -r answer 2>/dev/null || answer=""
      case "${answer}" in
        y|Y|yes|YES) ;;
        *) echo "[i] Aborted. Nothing was removed."; return 0 ;;
      esac
    else
      echo "[!] Non-interactive shell — pass '--yes' to uninstall without prompting."
      echo "    Example: cobot uninstall --yes"
      return 1
    fi
  fi

  # 1. Stop the running bot (graceful SIGTERM, then a hard-kill sweep)
  echo "[+] Stopping CoBot..."
  cmd_stop 2>/dev/null || true

  # 2. Remove the global 'cobot' CLI — both the npm link and the direct
  #    symlinks cmd_install may have dropped into system/user PATH dirs.
  echo "[+] Removing global 'cobot' CLI..."
  npm uninstall -g cobot 2>/dev/null || true
  local bin
  for bin in /usr/local/bin/cobot "${HOME}/.local/bin/cobot" "${HOME}/bin/cobot"; do
    if [ -L "${bin}" ] || [ -f "${bin}" ]; then
      rm -f "${bin}" && echo "    removed ${bin}" || true
    fi
  done

  # 3. Remove the launchd agent (cmd_stop already booted it out; this drops the
  #    plist so it doesn't come back at the next login).
  if have_launchd && [ -f "${AGENT_PLIST}" ]; then
    echo "[+] Removing launchd agent ${AGENT_LABEL}..."
    launchctl bootout "${GUI_DOMAIN}/${AGENT_LABEL}" >/dev/null 2>&1 || true
    # `stop` disabled the service; clear that record so a later reinstall of the
    # same label isn't silently blocked from bootstrapping.
    launchctl enable "${GUI_DOMAIN}/${AGENT_LABEL}" >/dev/null 2>&1 || true
    rm -f "${AGENT_PLIST}" && echo "    removed ${AGENT_PLIST}" || true
  fi

  # 4. Remove runtime & build artifacts
  echo "[+] Removing runtime & build artifacts..."
  rm -rf "${ROOT_DIR}/node_modules" "${ROOT_DIR}/dist" "${ROOT_DIR}/data" 2>/dev/null || true
  rm -f "${ROOT_DIR}/bot.log" "${ROOT_DIR}/bot.log.1" "${ROOT_DIR}/test.log" 2>/dev/null || true

  # 5. Remove config (holds your bot token). The example templates stay, so a
  #    later reinstall regenerates config.yaml/.env via setup.
  if [ -f "${ROOT_DIR}/config.yaml" ]; then
    rm -f "${ROOT_DIR}/config.yaml"
    echo "[+] Removed config.yaml"
  fi
  if [ -f "${ROOT_DIR}/.env" ]; then
    rm -f "${ROOT_DIR}/.env"
    echo "[+] Removed .env"
  fi

  echo "=========================================="
  echo " CoBot Uninstalled"
  echo " The source directory remains: ${ROOT_DIR}"
  echo " Remove it entirely with:  rm -rf \"${ROOT_DIR}\""
  echo "=========================================="
}

# ── Main Entry ───────────────────────────────────────────────────────────────

case "${1:-}" in
  install)
    cmd_install
    ;;
  start)
    cmd_start
    ;;
  stop)
    cmd_stop
    ;;
  restart)
    cmd_restart
    ;;
  status)
    cmd_status
    ;;
  update)
    cmd_update
    ;;
  uninstall)
    cmd_uninstall "${2:-}"
    ;;
  __run)
    # Internal: launchd invokes this. Not a user-facing command.
    cmd_run
    ;;
  *)
    echo "CoBot Management Script"
    echo ""
    echo "Usage: $0 {install|start|stop|restart|status|update|uninstall} [--yes]"
    echo ""
    echo "Commands:"
    echo "  install   - Install deps, create config, interactive setup, link CLI, then start."
    echo "  start     - Start CoBot as a GUI-session (Aqua) launchd agent, with proxy auto-injection."
    echo "  stop      - Gracefully stop CoBot process and clear SQLite task locks."
    echo "  restart   - Restart CoBot service."
    echo "  status    - Check running status, launchd session and recent logs."
    echo "  update    - Pull latest source from the remote, refresh deps, and restart."
    echo "  uninstall - Stop CoBot, remove global CLI, delete deps/data/config. (--yes skips prompt)"
    echo ""
    echo "Environment:"
    echo "  COBOT_AGENT_LABEL  launchd label (default: com.cobot.agent)"
    echo "  COBOT_KEEPALIVE=1  let launchd restart the bot after a crash (default: off)"
    exit 1
    ;;
esac
