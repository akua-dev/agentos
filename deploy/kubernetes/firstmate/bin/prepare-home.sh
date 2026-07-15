#!/bin/sh
set -eu

: "${HOME:?HOME must point at the mounted First Mate home}"

release_root=${AGENTOS_RELEASE_ROOT:-/opt/agentos}
release_root=${release_root%/}
system_config=${MISE_SYSTEM_CONFIG_FILE:-/etc/mise/config.toml}
fleet_config_directory=${MISE_CONFIG_DIR:-"$HOME/.config/mise"}
herdr_config=${HERDR_CONFIG_PATH:-"$HOME/.config/herdr/config.toml"}
pi_agent_directory=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}

umask 077
mkdir -p \
  "$fleet_config_directory/conf.d" \
  "$HOME/.local/bin" \
  "$HOME/.local/share/mise" \
  "$HOME/.local/state/agentos" \
  "$HOME/projects" \
  "$(dirname "$herdr_config")" \
  "$pi_agent_directory/extensions"

install -m 0600 "$release_root/agents/mise.toml" "$fleet_config_directory/config.toml"
install -m 0600 "$release_root/agents/mise.lock" "$fleet_config_directory/mise.lock"

if [ ! -e "$herdr_config" ]; then
  install -m 0600 /dev/null "$herdr_config"
  printf '%s\n' \
    'onboarding = false' \
    'version_check = false' \
    'manifest_check = false' \
    '' \
    '[session]' \
    'resume_agents_on_restore = true' \
    '' \
    '[experimental]' \
    'pane_history = false' \
    > "$herdr_config"
fi

mise trust "$system_config"
mise trust "$fleet_config_directory/config.toml"

(
  cd "$HOME"
  mise install --locked \
    node \
    github:oven-sh/bun \
    jq \
    kubectl \
    github:ogulcancelik/herdr \
    npm:@earendil-works/pi-coding-agent
)

trust_file="$pi_agent_directory/trust.json"
trust_file_next="$trust_file.agentos-next"
if [ -e "$trust_file" ]; then
  jq --arg path "$release_root" '. + {($path): true}' "$trust_file" > "$trust_file_next"
else
  jq -n --arg path "$release_root" '{($path): true}' > "$trust_file_next"
fi
chmod 0600 "$trust_file_next"
mv "$trust_file_next" "$trust_file"

herdr integration install pi
