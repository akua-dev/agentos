---
name: agentos-auth
description: Establish, inspect, rotate, revoke, and recover model-provider or source-provider authentication for AgentOS agents. Use for Pi Codex-subscription browser login, GitHub personal or App identity, device-code recovery, API-key or third-party fallback, provider changes, expired credentials, quota identity changes, and authentication verification.
---

# Manage AgentOS authentication

Handle provider credentials inside the owning Agent's persistent runtime
whenever the provider supports it. This direct path is the complete minimal
setup and recovery boundary. For a delegation-ready Fleet, recommend
`$agentos-ai-gateway` when several Agents or trusted harness automations need
model capacity and the Captain accepts its service lifecycle. Its server-owned
vault, Agentgateway policy-enforcement point and projected workload identity
are a different credential boundary, never a shortcut for copying Agent auth.

## Guardrails

1. Inspect provider, harness, credential location and current non-secret status first.
2. Ask before reading credentials, starting login, transferring a secret, rotating identity, or revoking access.
3. Never request secrets in chat or place them in prompts, repositories, manifests, command arguments, or normal logs.
4. Never copy an entire local Codex, Pi, or provider configuration directory.
5. Scope every Secret and provider credential to the Agent and selected
   workload that needs it. Never inject one organization-wide secret set into
   every harness, modify a harness-managed trust store implicitly or treat a
   credential as broader authority than its documented reversible operations.

Provider-issued device verification URIs and one-time user codes are
interactive login instructions, not access tokens, refresh tokens, API keys,
browser OAuth URLs, callback URLs or auth files. After the exact device login
is authorized, relay its verification URI and user code through the
authenticated Captain surface. Keep both out of Git, prompts, Task and
Assignment records, generated artifacts and reusable guidance, and retain all
bearer credentials only inside the owning runtime. This classification applies
only to a provider-supported device flow; it does not weaken the browser-login
URL rule below.

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

## Fleet model capacity

After First Mate has working direct authentication and Fleet identity, present
two complete postures before the first worker dispatch:

- Recommend the AI gateway for a Fleet expected to run multiple Agents or
  trusted harness automation. The gateway owns fresh provider OAuth chains and
  selected workloads present only kubelet-rotated identity to Agentgateway;
  they receive no Fleet-shared client credential or provider token.
- Keep direct per-Agent authentication as the minimal alternative. Every
  harness owns and refreshes its own credential on its own PVC; another
  Agent's Pi, Codex or provider auth file is never its bootstrap input.

Record the Captain's selected posture in the owning Mate's private context
through `$agentos-memory` and reuse it as fallible guidance for no-mistakes and
other trusted harness automation rather than inventing another authentication
choice at delivery time. The memory does not authorize installation, provider
login, operator-Secret creation, access-profile changes, cost or a live
workload restart; record exact
standing authority through Inbox with `$agentos-decisions`.
Before calling the Fleet delegation-ready, verify one harmless real no-tool
request from an approved selected client. If the posture is deferred, report
minimal single-Mate mode and keep every unauthenticated worker launch blocked.

## Secret-based fallback

When an approved harness requires a key, have the developer write it to a mode-`0600` file in a mode-`0700` temporary directory outside the repository. Transfer it without printing, expose it only to the owning workload, verify metadata plus a real auth probe, and remove staging only after takeover succeeds.

On failure, keep the agent in bootstrap or degraded mode. Preserve the existing credential until the replacement is verified unless the developer explicitly requests urgent revocation.

## GitHub identity

Organization-owned Fleet access uses the GitHub broker. Do not run `gh auth
login`, mint an installation token, create a per-Agent GitHub Secret, or mount
the GitHub App private key into a First Mate, Second Mate or Crewmate.

The only Agent-side credential is the kubelet-rotated, audience-bound
ServiceAccount token at `/var/run/secrets/agentos-egress/token`. The released
home reconciler configures native `git`, `gh` and `gh-axi` to call
`https://agentgateway-github.agentos.svc.cluster.local`. The workload helper
reads the projected token immediately before each native invocation, passes it
only in that child process environment, and never writes it to a remote URL,
Git credential store, `hosts.yml`, shell history or command argument. Do not
bypass the wrapper or run `gh auth` commands in broker mode.

Agentgateway authenticates the workload and asks the Effect authorizer plus
OpenFGA for the exact Mate, active Assignment, repository and operation. The
closed grant reaches the GitHub broker without a credential value. Only the
broker mounts `Secret/agentos-github-app`; it mints an installation token for
one repository and one minimum permission, strips every AgentOS identity or
grant header, injects the provider token, and streams the native response.

A Mate requests the exact repository and capability through durable Inbox.
Use `request` inside standing authority and `approval_request` when the access
or provider-visible action is consequential. First Mate maintains reusable
OpenFGA profiles and assignment ceilings; it does not mint or distribute
tokens. Relevant capabilities are repository read, contents write, issue
read/write, pull-request read/write and Actions read/dispatch. Unknown REST,
Git smart-HTTP or GraphQL shapes fail closed. Opaque GraphQL node mutations are
unsupported because their repository cannot be proven from the request.

Verify a harmless native read first. Preserve the real `git`, `gh` or `gh-axi`
status, stderr and provider response when reporting a denial or failure. A
`401` from GitHub invalidates the broker cache so the next authorized call
mints a new exact-scope token. If OpenFGA revokes the Assignment, profile,
ceiling or repository relation, later calls deny without waiting for the
provider token to expire.

The Captain creates or rotates `Secret/agentos-github-app` only in the core
`agentos` namespace, with keys `app-id`, `installation-id`,
`installation-owner`, and `private-key.pem`. Roll only the two-replica GitHub
broker after replacement. Agent Pods and domain namespaces are not restarted
and must never receive that Secret. Revocation removes the OpenFGA relation or
ceiling first; App key rotation and App uninstall remain separate provider
operations.
