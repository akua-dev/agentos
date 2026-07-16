---
name: agentos-auth
description: Establish, inspect, rotate, revoke, and recover model-provider authentication for AgentOS agents. Use for Pi Codex-subscription browser login, device-code recovery, API-key or third-party fallback, provider changes, expired credentials, quota identity changes, and authentication verification.
---

# Manage AgentOS authentication

Handle provider credentials inside the owning agent's persistent runtime whenever the provider supports it.

## Guardrails

1. Inspect provider, harness, credential location and current non-secret status first.
2. Ask before reading credentials, starting login, transferring a secret, rotating identity, or revoking access.
3. Never request secrets in chat or place them in prompts, repositories, manifests, command arguments, or normal logs.
4. Never copy an entire local Codex, Pi, or provider configuration directory.

## Pi with a Codex subscription

1. Verify that the persistent Pod binds Pi's fixed `http://localhost:1455/auth/callback` listener with `PI_OAUTH_CALLBACK_HOST=0.0.0.0`.
2. Read the seeded `FIRSTMATE_MODEL` and `FIRSTMATE_THINKING` values from the Pod spec and the effective non-secret defaults from `~/.pi/agent/settings.json`. Existing Pi settings are agent-owned and take precedence over release seeds. After approval, start `kubectl --context <context> --namespace agentos port-forward pod/agentos-firstmate-0 1455:1455` on the seed machine.
3. Attach with `kubectl --context <context> --namespace agentos exec -it pod/agentos-firstmate-0 --container firstmate -- herdr --session agentos-firstmate`.
4. In Pi, run `/login` with no trailing provider text. Choose `Sign in with an account`, `ChatGPT Plus/Pro (Codex Subscription)`, then `Browser login`. Pi treats text after `/login` as a provider filter, so do not use `/login openai-codex`.
5. When the seed agent is allowed to drive the developer's already signed-in Chrome profile, use `CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1 chrome-devtools-axi open <oauth-url>`. Plain `chrome-devtools-axi open` starts an isolated browser and is not this flow. Keep the complete one-time OAuth URL in memory, redact it from tool output, and never put it in chat, a file, or a reusable skill. Use fresh snapshots to select the developer's existing account and then `Continue`.
6. Reuse only a known agent-owned Chrome DevTools session. If its bridge lost Chrome after a browser restart, stop that session and retry profile auto-connect once. Do not take over an unrelated named session. If Chrome requires the developer to enable remote debugging or complete a Cloudflare human check, pause for that one human action; do not substitute another profile or loop the challenge.
7. Never expose the callback through a public Service or Ingress. Stop the port-forward after callback completion. If it cannot complete, use Pi's manual redirect-URL input; offer device code only as an explicit recovery choice.
8. Let Pi own and refresh `~/.pi/agent/auth.json` on the Agent PVC. Verify ownership, mode `0600`, and the presence of the `openai-codex` provider key without printing or copying credential values.
9. AgentOS seeds Pi's `defaultProvider`, `defaultModel`, and `defaultThinkingLevel` settings without replacing unrelated or user-owned settings. Its Pi extension adopts those persisted defaults once authentication becomes available, then stops reconciling so later user changes remain possible. Do not simulate model-selection key presses.
10. Verify the effective non-secret settings and Pi status, then request a short fixed response with no tools. Record only provider, model, thinking level and success. Detach from Herdr without stopping the agent with `Ctrl+B`, then lowercase `q`.

## Secret-based fallback

When an approved harness requires a key, have the developer write it to a mode-`0600` file in a mode-`0700` temporary directory outside the repository. Transfer it without printing, expose it only to the owning workload, verify metadata plus a real auth probe, and remove staging only after takeover succeeds.

On failure, keep the agent in bootstrap or degraded mode. Preserve the existing credential until the replacement is verified unless the developer explicitly requests urgent revocation.
