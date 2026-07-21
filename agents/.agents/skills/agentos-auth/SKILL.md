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
by default writes only that token to standard output. Never run it bare in a
recorded terminal. Consume it directly through the provider's standard
environment so the acting command and its real failure remain visible, for
example:

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

### Delegated GitHub App access

Keep the App private key in First Mate. A Second Mate or Crewmate that needs
provider access requests the exact repository names, permission levels,
purpose and Assignment through durable Inbox. Use `request` inside existing
standing authority and `approval_request` when new consequential provider
authority is required. A Second Mate relays an eligible child request upward;
it never receives the key or mints another token itself. First Mate may approve
scope already covered by the reviewed App installation and standing Captain
authority. Anything broader or materially consequential returns to the
Captain.

GitHub installation tokens expire after one hour. They may contain fewer
repositories and permissions than the installation, never more. Select the
least scope that still permits the declared delivery workflow: cloning needs
`contents: read`; pushing needs `contents: write`; pull-request creation or
updates need `pull_requests: write`; changing workflow files additionally
needs `workflows: write`. Add issue or other permissions only when the
Assignment actually uses those provider surfaces.

First Mate creates a mode-`0700` staging directory outside Git, writes a
mode-`0600` non-secret JSON scope file, then asks the helper to materialize the
token and its non-secret provider metadata without printing either:

```console
github-app-token \
  --scope-file "$staging/scope.json" \
  --token-file "$staging/token" \
  --metadata-file "$staging/metadata.json"
```

The scope object uses GitHub's native request fields: one of `repositories` or
`repository_ids`, plus optional `permissions`. The helper rejects unknown
fields, ambiguous repository selectors, empty selection arrays and more than
500 selected repositories before contacting GitHub. Its metadata contains the
provider expiry and granted scope but never the token.

Create or update one uniquely named Kubernetes Secret for the Agent and
Assignment by streaming `kubectl create secret generic --from-file ...
--dry-run=client -o json` into `kubectl apply -f -`; neither command receives a
credential value in argv or prints the rendered Secret. In the reviewed
per-Agent Kustomize overlay, mount that Secret read-only without `subPath` at
`/var/run/secrets/agentos/github`, set `GITHUB_TOKEN_FILE` to its `token` file
and `GITHUB_TOKEN_METADATA_FILE` to its `metadata.json` file, and expose neither
App ID nor private key. Record only the requested and granted scope, provider
expiry and Secret name in the relevant durable work context. Do not introduce a
credential table, broker or controller.

The child reads `GITHUB_TOKEN_FILE` afresh for every native provider or Git
command instead of exporting it into startup state. Configure Git's native
GitHub CLI credential helper once with the file value present, and provide a
fresh `GH_TOKEN` to each `git`, `gh-axi` or `gh` invocation. A projected Secret
update is eventually visible without a Pod restart; First Mate verifies the
new projection before relying on it.

After minting, First Mate arms one bounded supervision wake early enough to
replace the Secret before `expires_at`; this is a situation-specific background
wait, not a static daemon. Refresh repeats the same scope request and atomically
updates the Secret. A child that observes `401`, missing scope or an expired
file keeps its Assignment active and reports the exact failure and requested
delta upward. It does not request, recover or retain the App key. At handoff,
scope follows the new owner through a new Agent-specific Secret; at retirement
or authorized revocation, remove the mount and Secret and let any issued token
expire. Remove the staging directory after the Secret and projection are
verified.
