#!/bin/sh
set -eu

session=${HERDR_SESSION:-agentos-firstmate}
mode=${1:-}

case "$mode" in
  live)
    exec herdr status --json --session "$session"
    ;;
  ready)
    herdr status --json --session "$session" >/dev/null
    agents=$(herdr agent list --session "$session")
    count=$(printf '%s' "$agents" | jq -er '[.result.agents[]? | select(.name == "firstmate")] | length')
    [ "$count" -eq 1 ]
    exec herdr agent get firstmate --session "$session"
    ;;
  *)
    printf '%s\n' 'Usage: health.sh <live|ready>' >&2
    exit 2
    ;;
esac
