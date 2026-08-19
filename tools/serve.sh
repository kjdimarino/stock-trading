#!/usr/bin/env bash
# Start/stop the built app for testing.
#
# Finds server processes by scanning /proc for a node process whose argv is
# exactly our entry file. Matching on a substring (pkill -f) is unsafe here:
# the calling shell's own command line contains the string too, so pkill
# happily kills the shell that invoked it.
set -u
PORT="${PORT:-7777}"

find_servers() {
  local pid cmd exe
  for p in /proc/[0-9]*; do
    pid=${p#/proc/}
    [ -r "$p/cmdline" ] || continue
    exe=$(readlink "$p/exe" 2>/dev/null) || continue
    case "$exe" in *node*) ;; *) continue ;; esac
    cmd=$(tr '\0' '\n' < "$p/cmdline" 2>/dev/null)
    case "$cmd" in *paper-trader.mjs*|*paper-trader.js*|*tools/dev.mjs*) echo "$pid" ;; esac
  done
}

stop_all() {
  local pids; pids=$(find_servers)
  if [ -n "$pids" ]; then
    echo "stopping: $pids"
    kill $pids 2>/dev/null
    sleep 1
    pids=$(find_servers)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  fi
  sleep 0.5
}

case "${1:-start}" in
  stop) stop_all ;;
  start)
    stop_all
    NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-/root/.ccr/ca-bundle.crt}" \
      nohup node paper-trader.mjs > /tmp/pt-server.log 2>&1 &
    for i in $(seq 1 30); do
      if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
        echo "server up on :$PORT (pid $(find_servers | tr '\n' ' '))"; exit 0
      fi
      sleep 0.5
    done
    echo "server failed to start:"; cat /tmp/pt-server.log; exit 1
    ;;
esac
