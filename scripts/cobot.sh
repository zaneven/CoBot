#!/usr/bin/env bash
#
# CoBot Control Script
# Usage: ./scripts/cobot.sh [install|start|stop|restart|status]
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
  pgrep -f "src/index.ts" 2>/dev/null || true
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

  # 3. Test & rebuild native bindings if needed
  echo "[+] Checking better-sqlite3 native bindings..."
  if ! node --input-type=module -e "import Database from 'better-sqlite3'; new Database(':memory:');" >/dev/null 2>&1; then
    echo "[!] SQLite native bindings failed. Rebuilding for current Node.js runtime..."
    npm rebuild better-sqlite3
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
  echo " You can now run 'cobot <command>' from any directory:"
  echo "   cobot start    - Start CoBot service"
  echo "   cobot stop     - Stop CoBot service"
  echo "   cobot restart  - Restart CoBot service"
  echo "   cobot status   - View CoBot status & logs"
  echo "=========================================="
}

cmd_stop() {
  echo "=========================================="
  echo " Stopping CoBot"
  echo "=========================================="

  local pids
  pids=$(get_running_pids)

  if [ -z "${pids}" ] && [ ! -f "${PID_FILE}" ]; then
    echo "[i] CoBot is not currently running."
    return 0
  fi

  # Stop recorded PID or detected PIDs gracefully
  if [ -f "${PID_FILE}" ]; then
    local saved_pid
    saved_pid=$(cat "${PID_FILE}")
    if [ -n "${saved_pid}" ] && kill -0 "${saved_pid}" 2>/dev/null; then
      echo "[+] Sending SIGTERM to PID ${saved_pid}..."
      kill -15 "${saved_pid}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}"
  fi

  for pid in ${pids}; do
    if kill -0 "${pid}" 2>/dev/null; then
      echo "[+] Terminating process ${pid}..."
      kill -15 "${pid}" 2>/dev/null || true
    fi
  done

  # Wait up to 5 seconds for processes to exit
  local count=0
  while [ ${count} -lt 5 ]; do
    pids=$(get_running_pids)
    if [ -z "${pids}" ]; then
      break
    fi
    sleep 1
    count=$((count + 1))
  done

  # Force kill any remaining
  pids=$(get_running_pids)
  if [ -n "${pids}" ]; then
    echo "[!] Force killing remaining process(es): ${pids}..."
    for pid in ${pids}; do
      kill -9 "${pid}" 2>/dev/null || true
    done
  fi

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

  local existing_pids
  existing_pids=$(get_running_pids)

  if [ -n "${existing_pids}" ]; then
    echo "[!] CoBot is already running (PID: ${existing_pids}). Stop it first or run: $0 restart"
    exit 1
  fi

  export_proxy_env

  if [ -n "${PROXY_URL}" ]; then
    echo "[+] Proxy detected & enabled: ${PROXY_URL}"
  else
    echo "[!] No HTTP proxy detected. Telegram API outbound calls may require proxy on this network."
  fi

  echo "[+] Launching CoBot in background..."
  nohup npm run dev > "${LOG_FILE}" 2>&1 &
  local new_pid=$!

  echo "${new_pid}" > "${PID_FILE}"
  echo "[+] CoBot process spawned (PID: ${new_pid}). Logging to bot.log"

  # Wait 3 seconds to verify startup logs
  sleep 3

  echo "------------------------------------------"
  echo " Startup Log Preview:"
  echo "------------------------------------------"
  tail -n 12 "${LOG_FILE}" || true
  echo "------------------------------------------"

  if get_running_pids >/dev/null 2>&1; then
    echo "[+] CoBot is running and ready."
  else
    echo "[!] CoBot failed to start. Check ${LOG_FILE} for errors."
    exit 1
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
  *)
    echo "CoBot Management Script"
    echo ""
    echo "Usage: $0 {install|start|stop|restart|status}"
    echo ""
    echo "Commands:"
    echo "  install  - Install dependencies, create config templates, check native SQLite bindings."
    echo "  start    - Start CoBot service in background with proxy auto-injection."
    echo "  stop     - Gracefully stop CoBot process and clear SQLite task locks."
    echo "  restart  - Restart CoBot service."
    echo "  status   - Check running status and recent logs."
    exit 1
    ;;
esac
