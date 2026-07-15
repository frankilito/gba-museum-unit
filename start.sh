#!/usr/bin/env bash
# GBA · Museum Unit — launcher
#
# Anti-interference design (this machine runs multiple agent sessions):
#  1. Dedicated port 7391, declared in ./PORT — never a vite default (5xxx),
#     never a round number. strictPort: if taken, we REFUSE rather than hop.
#  2. We only ever manage our own pidfile (.runtime/preview.pid).
#     No pkill/kill by name pattern — other sessions' servers are untouchable.
#  3. Idempotent: if our server is already up, just print the URL.
#
# Usage: ./start.sh [start|stop|status]   (default: start)

set -euo pipefail
cd "$(dirname "$0")"

PORT=$(cat PORT 2>/dev/null || echo 7391)
HOST=127.0.0.1
URL="http://${HOST}:${PORT}/"
RUN_DIR=.runtime
PIDFILE="${RUN_DIR}/preview.pid"
LOGFILE="${RUN_DIR}/preview.log"
mkdir -p "${RUN_DIR}"

port_pid() { lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
our_pid() { [[ -f "${PIDFILE}" ]] && cat "${PIDFILE}" || true; }
alive() { local p="$1"; [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; }
responding() { curl -fsS -o /dev/null --max-time 2 "${URL}" 2>/dev/null; }

case "${1:-start}" in

stop)
  p="$(our_pid)"
  if alive "${p}"; then
    kill "${p}" && echo "stopped (pid ${p})"
  else
    echo "not running (no live pidfile)"
  fi
  rm -f "${PIDFILE}"
  ;;

status)
  p="$(our_pid)"; lp="$(port_pid)"
  if alive "${p}" && responding; then
    echo "running: ${URL} (pid ${p})"
  elif [[ -n "${lp}" ]]; then
    echo "PORT CONFLICT: ${PORT} is held by foreign pid ${lp} — our server is NOT running"
    exit 1
  else
    echo "not running"
    exit 1
  fi
  ;;

start|*)
  # 1. already up?
  p="$(our_pid)"
  if alive "${p}" && responding; then
    echo "already running: ${URL} (pid ${p})"
    open "${URL}" 2>/dev/null || true
    exit 0
  fi

  # 2. port held by someone else? refuse — never hijack, never hop
  lp="$(port_pid)"
  if [[ -n "${lp}" ]] && [[ "${lp}" != "$(our_pid)" ]]; then
    echo "ERROR: port ${PORT} is held by foreign pid ${lp}." >&2
    echo "This launcher refuses to hop ports (dedicated-port policy)." >&2
    echo "Free the port or change ./PORT — but coordinate with other agent sessions first." >&2
    exit 1
  fi

  # 3. dependencies
  if [[ ! -d node_modules ]]; then
    echo "installing dependencies..."
    npm install --no-audit --no-fund
  fi

  # 4. build if stale (only our own inputs trigger a rebuild)
  if [[ ! -f dist/index.html ]] || \
     [[ -n "$(find src public index.html vite.config.ts -newer dist/index.html -type f 2>/dev/null | head -1)" ]]; then
    echo "building (dist stale)..."
    npm run build
  fi

  # 5. launch preview (production build, COI headers from vite.config.ts)
  echo "starting preview on ${URL} ..."
  nohup ./node_modules/.bin/vite preview --port "${PORT}" --strictPort \
    >"${LOGFILE}" 2>&1 &
  echo $! >"${PIDFILE}"

  # 6. wait until it answers
  for _ in $(seq 1 40); do
    if responding; then
      echo "ready: ${URL} (pid $(our_pid), log: ${LOGFILE})"
      open "${URL}" 2>/dev/null || true
      exit 0
    fi
    sleep 0.5
  done
  echo "ERROR: server did not come up — see ${LOGFILE}" >&2
  tail -5 "${LOGFILE}" >&2 || true
  exit 1
  ;;
esac
