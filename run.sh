#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

PORT="${PORT:-3417}"
URL="http://localhost:${PORT}"
HEALTH="${URL}/api/health"

# If server already responds, just open the page
if curl -sf --max-time 1 "$HEALTH" >/dev/null 2>&1; then
  echo "→ server already running at $URL"
else
  echo "→ starting server on $URL ..."
  # start in background; log to .run.log
  PORT="$PORT" node server.js > .run.log 2>&1 &
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

echo "  done — $URL"
