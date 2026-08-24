#!/usr/bin/env bash
#
# CoBot Control Script
# Usage: ./scripts/cobot.sh [install|start|stop|restart|status|uninstall] [--yes]
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
DB_FILE="${ROOT_DIR}/data/cobot.db"

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
  npm install

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
  npm run typecheck

  # 5. Register global 'cobot' command
  echo "[+] Registering global 'cobot' CLI command..."
  npm link --force 2>/dev/null || true

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

  # Ensure a clean slate — clear any lingering instance before launching. This
  # is what lets `restart` reliably bring the bot back up.
  kill_all_cobot || true

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
  else
    echo "[!] CoBot failed to start. Check ${LOG_FILE} for errors."
    return 1
  fi
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
  else
    echo "[Status]: STOPPED"
  fi

  if [ -f "${LOG_FILE}" ]; then
    echo "------------------------------------------"
    echo " Recent Logs (tail bot.log):"
    echo "------------------------------------------"
    tail -n 10 "${LOG_FILE}"
  fi
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

  # 3. Remove runtime & build artifacts
  echo "[+] Removing runtime & build artifacts..."
  rm -rf "${ROOT_DIR}/node_modules" "${ROOT_DIR}/dist" "${ROOT_DIR}/data" 2>/dev/null || true
  rm -f "${ROOT_DIR}/bot.log" "${ROOT_DIR}/test.log" 2>/dev/null || true

  # 4. Remove config (holds your bot token). The example templates stay, so a
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
  uninstall)
    cmd_uninstall "${2:-}"
    ;;
  *)
    echo "CoBot Management Script"
    echo ""
    echo "Usage: $0 {install|start|stop|restart|status|uninstall} [--yes]"
    echo ""
    echo "Commands:"
    echo "  install   - Install deps, create config, interactive setup, link CLI, then start."
    echo "  start     - Start CoBot service in background with proxy auto-injection."
    echo "  stop      - Gracefully stop CoBot process and clear SQLite task locks."
    echo "  restart   - Restart CoBot service."
    echo "  status    - Check running status and recent logs."
    echo "  uninstall - Stop CoBot, remove global CLI, delete deps/data/config. (--yes skips prompt)"
    exit 1
    ;;
esac
