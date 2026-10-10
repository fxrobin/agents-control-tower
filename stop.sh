#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

PORT="${PORT:-3417}"
URL="http://localhost:${PORT}"
HEALTH="${URL}/api/health"

pids_for_port() {
  local pids=""

  # 1) lsof (most reliable)
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti tcp:"${PORT}" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then echo "$pids"; return 0; fi
  fi

  # 2) ss
  if command -v ss >/dev/null 2>&1; then
    # ss -lptn prints "users:((\"node\",pid=1234,fd=...))"
    pids=$(ss -lptn "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)
    if [[ -n "$pids" ]]; then echo "$pids"; return 0; fi
  fi

  # 3) fuser
  if command -v fuser >/dev/null 2>&1; then
    pids=$(fuser "${PORT}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true)
    if [[ -n "$pids" ]]; then echo "$pids"; return 0; fi
  fi

  # 4) fallback: pgrep by cmdline + cwd match (handles disowned `node server.js`)
  if command -v pgrep >/dev/null 2>&1; then
    local candidates
    candidates=$(pgrep -f "node.*server\.js" 2>/dev/null || true)
    for pid in $candidates; do
      # only keep pids whose cwd is this project (avoids killing unrelated servers)
      if [[ -e "/proc/${pid}/cwd" ]] && [[ "$(readlink -f "/proc/${pid}/cwd" 2>/dev/null)" == "$(pwd -P)" ]]; then
        pids+="${pid}"$'\n'
      fi
    done
    # if cwd check filtered everything, fall back to any pgrep match
    if [[ -z "$pids" ]]; then
      pids="$candidates"
    fi
    echo "$pids"
    return 0
  fi

  return 0
}

# Fast path: check health endpoint
health_ok=false
if curl -sf --max-time 1 "$HEALTH" >/dev/null 2>&1; then
  health_ok=true
fi

PIDS=$(pids_for_port)
# trim empty lines
PIDS=$(echo "$PIDS" | grep -E '^[0-9]+$' | sort -u || true)

if [[ -z "$PIDS" ]]; then
  if [[ "$health_ok" == true ]]; then
    echo "→ server responds on $HEALTH but no PID found (maybe different PORT or tool missing: lsof/ss/fuser/pgrep)" >&2
    exit 1
  else
    echo "→ server not running (port ${PORT} free)"
    exit 0
  fi
fi

echo "→ stopping server on port ${PORT} (pid: $(echo "$PIDS" | tr '\n' ' '))"

# SIGTERM first
for pid in $PIDS; do
  kill "$pid" 2>/dev/null || true
done

# Wait up to 5s for exit
for _ in $(seq 1 25); do
  still=""
  for pid in $PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      still+="${pid} "
    fi
  done
  if [[ -z "$still" ]]; then
    echo "  stopped"
    # verify port is actually free
    sleep 0.2
    if curl -sf --max-time 1 "$HEALTH" >/dev/null 2>&1; then
      echo "  warning: health still responds after kill (stale?)" >&2
    fi
    exit 0
  fi
  sleep 0.2
done

# Force kill remaining
for pid in $PIDS; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "  pid $pid still alive — killing -9"
    kill -9 "$pid" 2>/dev/null || true
  fi
done
sleep 0.3

# Final check
still=""
for pid in $PIDS; do
  if kill -0 "$pid" 2>/dev/null; then still+="${pid} "; fi
done
if [[ -z "$still" ]]; then
  echo "  killed"
  exit 0
else
  echo "  failed to stop pid(s): $still" >&2
  exit 1
fi
