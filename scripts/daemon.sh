#!/bin/bash
set -euo pipefail

# =============================================================================
# wechat-claude-code cross-platform daemon manager
# Supports: macOS (launchd) / Linux (systemd + nohup fallback)
# =============================================================================

DATA_DIR="${WCC_DATA_DIR:-${HOME}/.wechat-claude-code}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="wechat-claude-code"

# Path variables that must reach the daemon so it and the Claude Code CLI it
# spawns resolve the same directories as the user's own shell. Both are
# optional — unset means "use the default" (~/.claude and
# ~/.wechat-claude-code respectively).
#
# Note: ANTHROPIC_* / CLAUDE_API_KEY are still propagated below. They are
# *not* needed when the CLI reads its credentials from ~/.claude/settings.json
# (the Windows service works that way with zero credential env vars), but on
# macOS/Linux the daemon inherits nothing from the login shell, so dropping
# them would lock out users whose only credential source is a shell variable.
# They live in ~/Library/LaunchAgents and ~/.config/systemd/user — never in
# the repo — so unlike the Windows wrapper XML they can't leak into git.

# Escape a value for embedding in XML text.
xml_escape() {
  printf '%s' "${1:-}" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# Emit `<key>K</key><string>V</string>` lines for a launchd plist.
plist_path_env() {
  local var value
  for var in CLAUDE_CONFIG_DIR WCC_DATA_DIR; do
    value="${!var:-}"
    [ -z "$value" ] && continue
    printf '    <key>%s</key>\n    <string>%s</string>\n' "$var" "$(xml_escape "$value")"
  done
  return 0
}

# Emit `Environment="K=V"` lines for a systemd unit.
systemd_path_env() {
  local var value
  for var in CLAUDE_CONFIG_DIR WCC_DATA_DIR; do
    value="${!var:-}"
    [ -z "$value" ] && continue
    printf 'Environment="%s=%s"\n' "$var" "$value"
  done
  return 0
}

# Platform detection
OS_TYPE="$(uname -s)"

# =============================================================================
# macOS (launchd) functions
# =============================================================================

macos_plist_label() {
  echo "com.wechat-claude-code.bridge"
}

macos_plist_path() {
  echo "${HOME}/Library/LaunchAgents/$(macos_plist_label).plist"
}

macos_is_loaded() {
  launchctl print "gui/$(id -u)/$(macos_plist_label)" &>/dev/null
}

macos_start() {
  local plist_label="$(macos_plist_label)"
  local plist_path="$(macos_plist_path)"
  local node_bin="$(command -v node || echo '/usr/local/bin/node')"

  if macos_is_loaded; then
    echo "Already running (or plist loaded)"
    exit 0
  fi

  mkdir -p "$DATA_DIR/logs"

  # Collect Anthropic/Claude env vars for plist
  local plist_extra_env=""
  for var in ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_API_KEY; do
    if [ -n "${!var:-}" ]; then
      plist_extra_env="${plist_extra_env}    <key>${var}</key>
    <string>${!var}</string>
"
    fi
  done
  # ... plus the path variables, so the daemon and the CLI it spawns look in
  # the same places the user's shell does.
  plist_extra_env="${plist_extra_env}$(plist_path_env)"

  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plist_label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node_bin}</string>
    <string>${PROJECT_DIR}/dist/main.js</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DATA_DIR}/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${DATA_DIR}/logs/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${HOME}/.local/bin:${node_bin%/*}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
${plist_extra_env}  </dict>
</dict>
</plist>
PLIST

  launchctl load "$plist_path"
  echo "Started wechat-claude-code daemon (macOS launchd)"
}

macos_stop() {
  local plist_label="$(macos_plist_label)"
  local plist_path="$(macos_plist_path)"

  launchctl bootout "gui/$(id -u)/${plist_label}" 2>/dev/null || true
  rm -f "$plist_path"
  echo "Stopped wechat-claude-code daemon (macOS launchd)"
}

macos_status() {
  if macos_is_loaded; then
    local pid=$(pgrep -f "dist/main.js start" 2>/dev/null | head -1)
    if [ -n "$pid" ]; then
      echo "Running (PID: $pid)"
    else
      echo "Loaded but not running"
    fi
  else
    echo "Not running"
  fi
}

macos_logs() {
  local log_dir="${DATA_DIR}/logs"
  if [ -d "$log_dir" ]; then
    local latest=$(ls -t "${log_dir}"/bridge-*.log 2>/dev/null | head -1)
    if [ -n "$latest" ]; then
      tail -100 "$latest"
    else
      echo "No bridge logs found. Checking stdout/stderr:"
      for f in "${log_dir}"/stdout.log "${log_dir}"/stderr.log; do
        if [ -f "$f" ]; then
          echo "=== $(basename "$f") ==="
          tail -30 "$f"
        fi
      done
    fi
  else
    echo "No logs found"
  fi
}

# =============================================================================
# Linux (systemd) functions
# =============================================================================

linux_ensure_user_session() {
  if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null || true
  fi
  if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  fi
}

linux_service_file() {
  echo "${HOME}/.config/systemd/user/${SERVICE_NAME}.service"
}

linux_pid_file() {
  echo "${DATA_DIR}/${SERVICE_NAME}.pid"
}

linux_node_bin() {
  local node_bin="$(command -v node 2>/dev/null || echo '')"
  if [ -z "$node_bin" ]; then
    local nvm_default="${NVM_DIR:-${HOME}/.nvm}/versions/node"
    if [ -d "$nvm_default" ]; then
      node_bin="$(find "$nvm_default" -name "node" -type f 2>/dev/null | head -1)"
    fi
  fi
  echo "${node_bin:-/usr/bin/node}"
}

linux_systemd_available() {
  linux_ensure_user_session
  systemctl --user list-units &>/dev/null
}

linux_create_service_file() {
  local service_file="$(linux_service_file)"
  local node_bin="$(linux_node_bin)"

  mkdir -p "$(dirname "$service_file")"

  # Collect Anthropic/Claude env vars to pass through to the service
  local extra_env=""
  for var in ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_API_KEY; do
    if [ -n "${!var:-}" ]; then
      extra_env="${extra_env}Environment=${var}=${!var}
"
    fi
  done
  # ... plus the path variables, so the daemon and the CLI it spawns look in
  # the same places the user's shell does.
  extra_env="${extra_env}$(systemd_path_env)"

  cat > "$service_file" <<SERVICE
[Unit]
Description=WeChat Claude Code Bridge
Documentation=https://github.com/Wechat-ggGitHub/wechat-claude-code
After=network.target

[Service]
Type=simple
ExecStart=${node_bin} ${PROJECT_DIR}/dist/main.js start
WorkingDirectory=${PROJECT_DIR}
Restart=always
RestartSec=10
Environment=PATH=${HOME}/.local/bin:${node_bin%/*}:/usr/local/bin:/usr/bin:/bin
${extra_env}StandardOutput=append:${DATA_DIR}/logs/stdout.log
StandardError=append:${DATA_DIR}/logs/stderr.log
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
SERVICE

  chmod 644 "$service_file"
}

linux_reload_daemon() {
  linux_ensure_user_session
  systemctl --user daemon-reload 2>/dev/null || true
}

linux_direct_start() {
  local pid_file="$(linux_pid_file)"
  local node_bin="$(linux_node_bin)"

  if [ -f "$pid_file" ]; then
    local old_pid=$(cat "$pid_file" 2>/dev/null)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "Already running (PID: $old_pid)"
      exit 0
    fi
    rm -f "$pid_file"
  fi

  mkdir -p "$DATA_DIR/logs"

  echo "Starting wechat-claude-code daemon (direct mode)..."
  nohup "$node_bin" "${PROJECT_DIR}/dist/main.js" start \
    >> "$DATA_DIR/logs/stdout.log" \
    2>> "$DATA_DIR/logs/stderr.log" &
  local pid=$!
  echo "$pid" > "$pid_file"
  echo "Started (PID: $pid)"
  echo "Logs: $DATA_DIR/logs/stdout.log"
}

linux_direct_stop() {
  local pid_file="$(linux_pid_file)"

  if [ ! -f "$pid_file" ]; then
    echo "Not running (no PID file)"
    exit 0
  fi

  local pid=$(cat "$pid_file" 2>/dev/null)
  if [ -z "$pid" ]; then
    rm -f "$pid_file"
    echo "Stopped"
    exit 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    local count=0
    while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
      sleep 1
      count=$((count + 1))
    done
    kill -9 "$pid" 2>/dev/null || true
    echo "Stopped (PID: $pid)"
  else
    echo "Process not running (cleaning up PID file)"
  fi

  rm -f "$pid_file"
}

linux_direct_status() {
  local pid_file="$(linux_pid_file)"

  if [ ! -f "$pid_file" ]; then
    echo "Not running"
    exit 0
  fi

  local pid=$(cat "$pid_file" 2>/dev/null)
  if [ -z "$pid" ]; then
    echo "Not running (invalid PID file)"
    exit 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    echo "Running (PID: $pid)"
  else
    echo "Not running (stale PID file)"
  fi
}

linux_start() {
  if linux_systemd_available; then
    local service_file="$(linux_service_file)"

    if systemctl --user is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
      echo "Already running"
      exit 0
    fi

    mkdir -p "$DATA_DIR/logs"
    linux_create_service_file
    linux_reload_daemon

    systemctl --user start "${SERVICE_NAME}"
    systemctl --user enable "${SERVICE_NAME}" 2>/dev/null || true
    echo "Started wechat-claude-code daemon (Linux systemd)"
  else
    echo "Note: systemd user session not available, using direct mode"
    echo "To enable systemd mode, run: 'loginctl enable-linger $(whoami)'"
    echo ""
    linux_direct_start
  fi
}

linux_stop() {
  if linux_systemd_available && systemctl --user cat "${SERVICE_NAME}" &>/dev/null; then
    systemctl --user stop "${SERVICE_NAME}" 2>/dev/null || true
    systemctl --user disable "${SERVICE_NAME}" 2>/dev/null || true
    echo "Stopped wechat-claude-code daemon (Linux systemd)"
  else
    linux_direct_stop
  fi
}

linux_restart() {
  linux_stop
  sleep 1
  linux_start
}

linux_status() {
  if linux_systemd_available && systemctl --user cat "${SERVICE_NAME}" &>/dev/null; then
    if systemctl --user is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
      local pid=$(systemctl --user show-property --value=MainPID "${SERVICE_NAME}" 2>/dev/null)
      if [ -n "$pid" ] && [ "$pid" != "0" ]; then
        echo "Running (PID: $pid)"
      else
        echo "Active"
      fi
    else
      echo "Not running"
    fi

    if systemctl --user cat "${SERVICE_NAME}" &>/dev/null; then
      echo ""
      systemctl --user status "${SERVICE_NAME}" --no-pager 2>/dev/null || true
    fi
  else
    linux_direct_status
  fi
}

linux_logs() {
  if command -v journalctl >/dev/null 2>&1; then
    if journalctl --user --unit="${SERVICE_NAME}" --quiet &>/dev/null; then
      echo "=== systemd journal logs (last 100 lines) ==="
      journalctl --user --unit="${SERVICE_NAME}" --no-pager -n 100 2>/dev/null || true
      echo ""
      echo "=== File logs ==="
    fi
  fi

  local log_dir="${DATA_DIR}/logs"
  if [ -d "$log_dir" ]; then
    for f in "${log_dir}"/stdout.log "${log_dir}"/stderr.log; do
      if [ -f "$f" ]; then
        echo "=== $(basename "$f") ==="
        tail -50 "$f"
        echo ""
      fi
    done
  else
    echo "No logs found"
  fi
}

# =============================================================================
# Windows (node-windows) functions
# =============================================================================
# Detected when uname -s returns MINGW* / MSYS* / CYGWIN* (Git Bash, MSYS2,
# Cygwin on Windows). The daemon runs as a real Windows Service registered
# with the Service Control Manager via the `node-windows` package, which is
# invoked through scripts/windows-service.cjs.
#
# Note: installing or modifying a Windows service requires Administrator
# privileges. `start` / `install` will fail with a hint if not elevated.

windows_service_script() {
  # Path to the Node helper, in Windows-native form (needed when the Node
  # child process is launched via CreateProcess by node-windows).
  cygpath -w "${PROJECT_DIR}/scripts/windows-service.cjs"
}

windows_service_name() {
  # node-windows registers the SCM entry under the `id` field of the Service
  # object, with `.exe` appended automatically. The display name shown in
  # services.msc is the friendly `name` field (e.g. "WeChat Claude Code
  # Bridge"), but SCM queries like `sc.exe query` and `NET START` use the
  # `id` field as the service key. Verified:
  #   sc.exe query wechatclaudecodebridge.exe   → STATE: 4 RUNNING
  #   sc.exe query WeChatClaudeCodeBridge       → 1060 not exists
  # The previous comment claiming `WeChatClaudeCodeBridge` was the SCM key
  # was wrong — `npm run daemon:reinstall` silently failed at `sc stop`
  # because of this exact bug.
  echo "wechatclaudecodebridge.exe"
}

windows_is_installed() {
  # sc.exe exits non-zero when the service does not exist.
  sc.exe query "$(windows_service_name)" &>/dev/null
}

windows_run_service() {
  local subcommand="$1"
  local node_bin
  node_bin="$(command -v node 2>/dev/null || echo node)"
  local win_node_bin
  win_node_bin="$(cygpath -w "$node_bin")"
  local win_script
  win_script="$(windows_service_script)"
  "$win_node_bin" "$win_script" "$subcommand"
}

windows_start() {
  if windows_is_installed; then
    windows_run_service start
  else
    echo "Service not installed yet. Installing now..."
    echo "(If this fails, re-run from an Administrator Git Bash.)"
    echo ""
    windows_run_service install
  fi
}

windows_stop() {
  # Use sc.exe stop directly instead of windows_run_service stop
  # (node-windows s.stop()). The s.stop() path only marks the wrapper as
  # "stopping" and relies on the wrapper to self-exit and kill its child,
  # but in practice wrapper keeps reporting SERVICE_RUNNING to SCM and
  # neither the child nor the wrapper die — leaving the OLD main.js
  # process running with stale dist code after `npm run deploy`.
  #
  # sc.exe stop forces a SERVICE_STOP_PENDING through SCM, which makes
  # wrapper.js take its forcekill branch (process.exit on SIGTERM path),
  # killing both itself and the child main.js. SCM then sees the service
  # as STOPPED and the FAILURE_ACTIONS recovery (5s/10s/30s/60s restarts)
  # automatically respawns the wrapper, which in turn reads the freshly
  # built dist/main.js — completing the redeploy end-to-end.
  if ! windows_is_installed; then
    echo "Service not installed (nothing to stop)"
    return 0
  fi
  echo "Stopping service 'WeChatClaudeCodeBridge' (via sc.exe)..."
  sc.exe stop "$(windows_service_name)" >/dev/null 2>&1 || true
}

windows_install_watchdog() {
  windows_run_service install-watchdog
}

windows_uninstall_watchdog() {
  windows_run_service uninstall-watchdog
}

windows_start_watchdog() {
  windows_run_service start-watchdog
}

windows_stop_watchdog() {
  windows_run_service stop-watchdog
}

windows_restart() {
  windows_run_service restart
}

windows_status() {
  if ! windows_is_installed; then
    echo "Not installed"
    return 0
  fi
  local output
  output="$(sc.exe query "$(windows_service_name)" 2>&1)" || true
  # Use `|| true` on each pipeline below: with `set -o pipefail` (set at the
  # top of this script), a missing match in grep returns non-zero and would
  # cause the whole `local` assignment to abort. STOPPED services have no
  # PID line at all, so the PID extraction will always be empty for them.
  local state
  state="$(echo "$output" | grep -E '^\s*STATE\s*:' | sed -E 's/.*STATE\s*:\s*[0-9]+\s+//' | head -1 || true)"
  state="${state%"${state##*[![:space:]]}"}"  # trim trailing whitespace
  if [ -z "$state" ]; then
    state="Unknown"
  fi
  local pid
  pid="$(echo "$output" | grep -E '^\s*PID\s*:' | sed -E 's/.*PID\s*:\s*//' | tr -d '\r' | head -1 || true)"
  pid="${pid//[[:space:]]/}"  # strip any whitespace
  if [ -n "$pid" ]; then
    echo "Running (PID: $pid)"
  else
    echo "Installed (state: $state)"
  fi
}

windows_logs() {
  # node-windows writes stdout / stderr / wrapper logs into the directory
  # passed via `logpath` (configured in scripts/windows-service.cjs to
  # ${DATA_DIR}/logs). The wrapper .exe and .xml themselves live in
  # ${PROJECT_DIR}/dist/daemon/, but those are binaries, not logs.
  local log_dir="${DATA_DIR}/logs"
  if [ ! -d "$log_dir" ]; then
    echo "No logs found at $log_dir (has the service been started yet?)"
    return 0
  fi

  # `set -o pipefail` (set at the top of this script) makes bare `ls | head`
  # pipelines fail when the glob has no matches. Wrap in `|| true` to keep
  # the local assignment alive under `set -e`.
  local latest
  latest=$(ls -t "${log_dir}"/wechatclaudecodebridge.*.log "${log_dir}"/bridge-*.log "${log_dir}"/*.log 2>/dev/null | head -1 || true)
  if [ -z "$latest" ]; then
    echo "No .log files found in $log_dir"
    return 0
  fi

  echo "=== $(basename "$latest") ==="
  tail -100 "$latest"
}

# =============================================================================
# Main dispatcher
# =============================================================================

main() {
  local command="${1:-}"

  case "$OS_TYPE" in
    Darwin)
      case "$command" in
        start)   macos_start ;;
        stop)    macos_stop ;;
        restart) macos_stop; sleep 1; macos_start ;;
        status)  macos_status ;;
        logs)    macos_logs ;;
        *)
          echo "Usage: daemon.sh {start|stop|restart|status|logs}"
          echo "Platform: macOS (launchd)"
          exit 1
          ;;
      esac
      ;;
    Linux)
      case "$command" in
        start)   linux_start ;;
        stop)    linux_stop ;;
        restart) linux_restart ;;
        status)  linux_status ;;
        logs)    linux_logs ;;
        *)
          echo "Usage: daemon.sh {start|stop|restart|status|logs}"
          echo "Platform: Linux (systemd)"
          exit 1
          ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*)
      case "$command" in
        start)     windows_start ;;
        stop)      windows_stop ;;
        restart)
          echo "Error: 'restart' subcommand removed on Windows."
          echo "The wrapper auto-restarts main.js on exit; for full redeploy use 'npm run redeploy' (build + reinstall)."
          exit 2
          ;;
        status)    windows_status ;;
        logs)      windows_logs ;;
        install)   windows_run_service install ;;
        uninstall) windows_run_service uninstall ;;
        reinstall) windows_run_service reinstall ;;
        pause)     windows_run_service pause ;;
        resume)    windows_run_service resume ;;
        install-watchdog)   windows_install_watchdog ;;
        uninstall-watchdog) windows_uninstall_watchdog ;;
        start-watchdog)     windows_start_watchdog ;;
        stop-watchdog)      windows_stop_watchdog ;;
        *)
          echo "Usage: daemon.sh {start|stop|status|logs|install|uninstall|reinstall|pause|resume|install-watchdog|uninstall-watchdog|start-watchdog|stop-watchdog}"
          echo "Platform: Windows (node-windows service + watchdog-v2)"
          exit 1
          ;;
      esac
      ;;
    *)
      echo "Error: Unsupported platform '$OS_TYPE'"
      echo "Supported platforms: macOS (Darwin), Linux, Windows (Git Bash / MSYS / Cygwin)"
      exit 1
      ;;
  esac
}

main "$@"
