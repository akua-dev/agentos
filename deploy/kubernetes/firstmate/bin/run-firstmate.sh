#!/bin/sh
set -eu

release_root=${AGENTOS_RELEASE_ROOT:-/opt/agentos}
release_root=${release_root%/}
session=${HERDR_SESSION:-agentos-firstmate}
firstmate_cwd=${FIRSTMATE_CWD:-"$release_root/agents/firstmate"}
firstmate_model=${FIRSTMATE_MODEL:-openai-codex/gpt-5.6-terra}
firstmate_thinking=${FIRSTMATE_THINKING:-high}
server_pid=
observer_pid=

cleanup() {
  if [ -n "$observer_pid" ] && kill -0 "$observer_pid" 2>/dev/null; then
    kill "$observer_pid" 2>/dev/null || true
    wait "$observer_pid" 2>/dev/null || true
  fi
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}

terminate() {
  exit 0
}

trap cleanup EXIT
trap terminate INT TERM

herdr server --session "$session" &
server_pid=$!

server_ready=false
attempt=0
while [ "$attempt" -lt 60 ]; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid"
    exit $?
  fi
  if herdr status --json --session "$session" >/dev/null 2>&1; then
    server_ready=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.5
done

if [ "$server_ready" != true ]; then
  printf '%s\n' "Herdr session $session did not become ready within 30 seconds." >&2
  exit 1
fi

agents=$(herdr agent list --session "$session")
firstmate_count=$(printf '%s' "$agents" | jq -er '[.result.agents[]? | select(.name == "firstmate")] | length')

case "$firstmate_count" in
  0)
    herdr agent start firstmate \
      --cwd "$firstmate_cwd" \
      --no-focus \
      --session "$session" \
      -- \
      pi \
      --model "$firstmate_model" \
      --thinking "$firstmate_thinking"
    ;;
  1)
    herdr terminal session observe firstmate \
      --cols 120 \
      --rows 40 \
      --session "$session" \
      >/dev/null 2>&1 &
    observer_pid=$!

    attempt=0
    while [ "$attempt" -lt 20 ]; do
      if herdr agent get firstmate --session "$session" >/dev/null 2>&1; then
        sleep 0.2
        break
      fi
      attempt=$((attempt + 1))
      sleep 0.1
    done

    if kill -0 "$observer_pid" 2>/dev/null; then
      kill "$observer_pid" 2>/dev/null || true
      wait "$observer_pid" 2>/dev/null || true
    fi
    observer_pid=
    ;;
  *)
    printf '%s\n' \
      "Refusing to start: expected at most one Herdr agent named firstmate, found $firstmate_count." \
      >&2
    exit 1
    ;;
esac

wait "$server_pid"
server_status=$?
server_pid=
exit "$server_status"
