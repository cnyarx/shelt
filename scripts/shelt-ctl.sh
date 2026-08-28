#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONFIG_DIR=${HERDR_PLUGIN_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins/config/shelt}
STATE_DIR=${HERDR_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/shelt}
ENV_FILE="$CONFIG_DIR/.env"
PID_FILE="$STATE_DIR/shelt.pid"
LOG_FILE="$STATE_DIR/shelt.log"
SHELT_BIN=${SHELT_BIN:-$ROOT/release/shelt-linux-x86_64-musl}

mkdir -p "$CONFIG_DIR" "$STATE_DIR"
chmod 700 "$CONFIG_DIR" "$STATE_DIR"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

build() {
  cd "$ROOT"
  bun install --frozen-lockfile 2>/dev/null || bun install
  bun run typecheck
  bun run test
  bun run compile
  "$HOME/.cargo/bin/cargo" test
}

running() {
  [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

start() {
  if running; then
    echo "Shelt already running (PID $(cat "$PID_FILE"))"
    return
  fi
  [[ -x "$SHELT_BIN" ]] || build
  export HERDR_PLUGIN_STATE_DIR="$STATE_DIR"
  export SHELT_STATE_DIR="$STATE_DIR"
  "$SHELT_BIN" start
}

stop() {
  export SHELT_STATE_DIR="$STATE_DIR"
  "$SHELT_BIN" stop
}

url() {
  echo "http://${SHELT_HOST:-127.0.0.1}:${SHELT_PORT:-8790}"
}

case "${1:-}" in
  build) build ;;
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) export SHELT_STATE_DIR="$STATE_DIR"; "$SHELT_BIN" status ;;
  url) url ;;
  *) echo "usage: $0 {build|start|stop|restart|status|url}" >&2; exit 2 ;;
esac
