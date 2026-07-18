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
5. Scope every Secret and provider credential to the Agent and selected
   workload that needs it. Never inject one organization-wide secret set into
   every harness, modify a harness-managed trust store implicitly or treat a
   credential as broader authority than its documented reversible operations.

## Pi with a Codex subscription

1. Resolve the target Agent and its Kubernetes context, namespace, Pod,
   container, Herdr session and Pi home from the selected installation or
   rendered workload and, once initialized, Fleet state. Stop if existing
   Pod, Herdr or Pi state suggests more than one authoritative writer. The
   released First- and Second-Mate workloads name their runtime container
   `agentos`; the common Crewmate workload names it `crewmate`. Inspect the
   effective workload instead of deriving a container name from the role.
2. Verify that the persistent Pod binds Pi's fixed
   `http://localhost:1455/auth/callback` listener with
   `PI_OAUTH_CALLBACK_HOST=0.0.0.0`.
3. Inspect the effective non-secret Pi settings in
   `~/.pi/agent/settings.json` without changing them. AgentOS does not seed
   provider, model or thinking defaults. After approval, start
   `kubectl --context <context> --namespace <namespace> port-forward pod/<pod> 1455:1455`
   on the seed machine.
4. Attach with
   `kubectl --context <context> --namespace <namespace> exec -it pod/<pod> --container <container> -- herdr --session <session>`.
5. In Pi, run `/login` with no trailing provider text. Choose `Sign in with an account`, `ChatGPT Plus/Pro (Codex Subscription)`, then `Browser login`. Pi treats text after `/login` as a provider filter, so do not use `/login openai-codex`.
6. When the seed agent is allowed to drive the developer's already signed-in Chrome profile, use `CHROME_DEVTOOLS_AXI_AUTO_CONNECT=1 chrome-devtools-axi open <oauth-url>`. Plain `chrome-devtools-axi open` starts an isolated browser and is not this flow. Keep the complete one-time OAuth URL in memory, redact it from tool output, and never put it in chat, a file, or a reusable skill. Use fresh snapshots to select the developer's existing account and then `Continue`.
7. Reuse only a known agent-owned Chrome DevTools session. If its bridge lost Chrome after a browser restart, stop that session and retry profile auto-connect once. Do not take over an unrelated named session. If Chrome requires the developer to enable remote debugging or complete a Cloudflare human check, pause for that one human action; do not substitute another profile or loop the challenge.
8. Never expose the callback through a public Service or Ingress. Stop the port-forward after callback completion. If it cannot complete, use Pi's manual redirect-URL input; offer device code only as an explicit recovery choice.
9. Let Pi own and refresh `~/.pi/agent/auth.json` on the Agent PVC. Verify ownership, mode `0600`, and the presence of the `openai-codex` provider key without printing or copying credential values.
10. After login, let the Captain select or retain Pi's native defaults. Load `$agentos-harnesses` before proposing a model or thinking change. Do not simulate model-selection key presses or install a defaults-reconciliation extension.
11. Verify Pi status, then request a short fixed response with no tools. Record only the effective provider, model, thinking level and success. Detach from Herdr without stopping the agent with `Ctrl+B`, then lowercase `q`.

## Secret-based fallback

When an approved harness requires a key, have the developer write it to a mode-`0600` file in a mode-`0700` temporary directory outside the repository. Transfer it without printing, expose it only to the owning workload, verify metadata plus a real auth probe, and remove staging only after takeover succeeds.

On failure, keep the agent in bootstrap or degraded mode. Preserve the existing credential until the replacement is verified unless the developer explicitly requests urgent revocation.
