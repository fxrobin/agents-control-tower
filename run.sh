#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

PORT="${PORT:-3417}"
HOST="${HOST:-127.0.0.1}"
URL="http://localhost:${PORT}"
HEALTH="${URL}/api/health"

case "$HOST" in
  127.0.0.1|localhost|::1) WANT_NETWORK=false ;;
  *) WANT_NETWORK=true ;;
esac

# If server already responds, just open the page
if HEALTH_JSON=$(curl -sf --max-time 1 "$HEALTH" 2>/dev/null); then
  echo "→ server already running at $URL"
  if [[ "$HEALTH_JSON" == *'"network":true'* ]]; then RUNNING_NETWORK=true; else RUNNING_NETWORK=false; fi
  if [[ "$RUNNING_NETWORK" != "$WANT_NETWORK" ]]; then
    echo "  warning: it runs in $([[ $RUNNING_NETWORK == true ]] && echo network || echo local) mode — run ./stop.sh first to switch" >&2
  fi
else
  echo "→ starting server on $URL ..."
  # start in background; log to .run.log
  PORT="$PORT" HOST="$HOST" node server.js > .run.log 2>&1 &
  SERVER_PID=$!
  echo "  pid $SERVER_PID (log: .run.log)"

  # wait for health (max 5s)
  for i in $(seq 1 25); do
    if curl -sf --max-time 1 "$HEALTH" >/dev/null 2>&1; then
      echo "  ready"
      break
    fi
    # exit early if server died
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "  server failed to start — see .run.log" >&2
      cat .run.log >&2 || true
      exit 1
    fi
    sleep 0.2
  done

  if ! curl -sf --max-time 1 "$HEALTH" >/dev/null 2>&1; then
    echo "  timeout waiting for $HEALTH" >&2
    cat .run.log >&2 || true
    kill "$SERVER_PID" 2>/dev/null || true
    exit 1
  fi

  # keep server running; detach from this shell and show how to stop
  disown "$SERVER_PID" 2>/dev/null || true
  echo "  (stop: kill $SERVER_PID)"
fi

# open browser unless --no-browser
if [[ "$1" != "--no-browser" ]]; then
  echo "→ opening $URL"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 &
  elif command -v sensible-browser >/dev/null 2>&1; then
    sensible-browser "$URL" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 &
  else
    echo "  (no browser opener found — open $URL manually)"
  fi
fi

# Mode réseau : adresses à ouvrir sur un autre appareil (jeton inclus)
if [[ "$WANT_NETWORK" == true ]] && grep -q '^  LAN ' .run.log 2>/dev/null; then
  echo "→ from another device on the same network, open once:"
  grep '^  LAN ' .run.log | grep -v '(virtuelle)' | sed 's/^  LAN /    /'
  echo "  (port ${PORT} must be allowed by the firewall, e.g. sudo ufw allow from 192.168.1.0/24 to any port ${PORT} proto tcp)"
fi

echo "  done — $URL"
