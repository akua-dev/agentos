---
name: agentos-auth
description: Establish, inspect, rotate, revoke, and recover model-provider or source-provider authentication for AgentOS agents. Use for Pi Codex-subscription browser login, GitHub personal or App identity, device-code recovery, API-key or third-party fallback, provider changes, expired credentials, quota identity changes, and authentication verification.
---

# Manage AgentOS authentication

Handle provider credentials inside the owning agent's persistent runtime whenever the provider supports it. This direct path is a complete AgentOS setup. If the Captain explicitly selects pooled Fleet capacity instead, load `$agentos-quota-router`; its server-owned vault and client Secret are a different credential boundary, not a shortcut for copying Agent auth.

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

## GitHub identity

Present two complete paths and let the Captain choose:

- Personal or individual development: authenticate the owning persistent Mate
  through native `gh auth login` and its provider-supported browser or device
  flow. Keep the resulting `gh` state on that Mate's PVC; never copy a local
  credential store into the Pod.
- Organization-owned Fleet identity: use one dedicated GitHub App whose
  repository selection and permissions the Captain has reviewed. A broad
  installation is valid only when the Captain deliberately accepts that broad
  provider authority; GitHub authentication still grants no AgentOS authority.

The GitHub App client secret is not used for installation-token authentication
and must not be transferred. Inventory the non-secret App ID, installation ID,
effective repository selection and permissions. Have the Captain place the App
private key in a mode-`0600` file outside the repository. With explicit
credential and workload-mutation approval, stream that file into a Secret named
`agentos-github-app` in the owning namespace with these keys:

- `app-id`
- `installation-id`
- `private-key.pem`

Do not print or persist the rendered Secret manifest. Apply the released
`agents/firstmate/kubernetes/patches/github-app.yaml` to the effective First
Mate StatefulSet without replacing its image, PVC, database wiring or unrelated
configuration. The patch mounts only the private key into only the First Mate
runtime at `/var/run/secrets/agentos/github`; init containers, Second Mates and
Crewmates do not receive it. Ask before the required First Mate Pod replacement,
then verify the retained PVC and native Pi session after rollout.

`github-app-token` performs only installation-token minting. It reads the
mounted key and non-secret IDs, requests one short-lived token from GitHub and
writes only that token to standard output. Never run it bare in a recorded
terminal. Consume it directly through the provider's standard environment so
the acting command and its real failure remain visible, for example:

```console
GH_TOKEN="$(github-app-token)" gh-axi repo view akua-dev/agentos
```

For HTTPS Git operations, configure Git's native GitHub CLI credential helper
once through `gh auth setup-git`, then give each `git` invocation a fresh
`GH_TOKEN` environment value from the same command substitution. Do not export
or cache the installation token in shell startup state, Pi settings, Fleet
rows, task briefs or Agent home.

Verify a harmless read first. A provider-visible write remains separately
gated by the accepted delivery workflow or an explicit Captain approval; after
one approved proof, verify GitHub attributes it to the App. On expiry, mint a
new token rather than recovering an old one. For rotation, update the Secret,
replace one First Mate Pod and verify the new key before revoking the old key.
For revocation, remove the mount and Secret and revoke or uninstall the App as
selected; report any retained provider sessions or repository access.
