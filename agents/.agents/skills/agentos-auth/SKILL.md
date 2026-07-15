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

1. Enter the persistent Pi pane and run Pi's `/login` flow.
2. Select `OpenAI (ChatGPT Plus/Pro)` and browser login.
3. Bind Pi's callback inside the pod with `PI_OAUTH_CALLBACK_HOST=0.0.0.0` and create a temporary local Kubernetes port-forward for `localhost:1455` only after approval.
4. Do not create a public Service or Ingress for the callback.
5. If the callback cannot complete, use Pi's supported manual redirect-URL input. Offer device code only as an explicit recovery choice.
6. Let Pi own and refresh `~/.pi/agent/auth.json` on the agent PVC with restrictive file permissions.
7. Verify the release-selected provider and model with a harmless real request without printing credential contents.

## Secret-based fallback

When an approved harness requires a key, have the developer write it to a mode-`0600` file in a mode-`0700` temporary directory outside the repository. Transfer it without printing, expose it only to the owning workload, verify metadata plus a real auth probe, and remove staging only after takeover succeeds.

On failure, keep the agent in bootstrap or degraded mode. Preserve the existing credential until the replacement is verified unless the developer explicitly requests urgent revocation.
