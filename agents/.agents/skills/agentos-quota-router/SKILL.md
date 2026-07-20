---
name: agentos-quota-router
description: Install, configure, inspect, recover, rotate, or retire the optional AgentOS Fleet quota router for pooled Codex subscriptions and an explicit OpenAI API-key fallback. Use when a First or Second Mate considers shared AI capacity, server-owned provider OAuth, the fleet-codex Pi/Codex provider, quota-aware account routing, router client Secrets, or router 401/429 failures.
---

# Operate the Fleet quota router

Keep direct per-Agent provider login as the complete default. Select the quota
router only when the Captain wants pooled Fleet capacity and accepts one
additional credential authority and service lifecycle.

The router chooses credentials for the requested model; it never chooses a
model, queues a prompt or hides the provider response. PostgreSQL remains Fleet
coordination truth. The router's retained PVC owns only its OAuth vault,
observed quota, session assignments, blocks and active reservations.

## Decide and inspect

1. Resolve the exact AgentOS revision, Kubernetes context, `agentos` namespace,
   intended clients and current provider authentication.
2. Inspect whether `StatefulSet/quota-router`, `Service/quota-router`,
   `Secret/quota-router-client`, its PVC and the selected-client NetworkPolicy
   already exist. Inspect only metadata and non-secret status; do not print
   Secret data or the vault.
3. Compare two complete paths:
   - direct authentication: each Agent's native harness owns its credential on
     its PVC;
   - pooled capacity: the router owns fresh server-side Codex OAuth chains and
     selected Agent Pods receive only a Fleet client token.
4. Reject pooled routing when the endpoint would require a public Ingress, the
   storage cannot remain single-writer, selected Pods cannot be isolated, or a
   third-party policy forbids subscription proxying. Do not claim that pooled
   personal subscription use is provider-endorsed; treat it as an explicit
   experimental Captain choice.
5. A Second Mate may inspect and report router state but must route Fleet-wide
   installation, account changes and shared Secret changes through First Mate
   unless its exact charter and standing authorization cover them.

Ask before installing the service, creating or distributing its client Secret,
starting each provider login, enabling API-key fallback, changing an Agent's
provider/environment, interrupting a live harness, deleting an account, or
removing retained state. State the credential blast radius and whether the
action can incur provider cost.

## Install the optional service

Use the reviewed topology at
`services/quota-router/kubernetes`. Render and inspect it before
apply. It must remain one non-root replica, a ClusterIP without Ingress, a
retained ReadWriteOnce PVC and the selected-client NetworkPolicy.

Create a high-entropy client token in a mode-`0600` file outside Git. Pass its
path—not its value—to native kubectl:

```console
kubectl --context <context> --namespace agentos create secret generic quota-router-client \
  --from-file=token=<private-token-file> --dry-run=client --output=yaml
kubectl --context <context> kustomize services/quota-router/kubernetes
kubectl --context <context> --namespace agentos apply --filename <reviewed-render>
kubectl --context <context> --namespace agentos rollout status statefulset/quota-router
```

Pipe or stage the first command through the approved apply workflow without
printing the rendered Secret. Delete local staging only after the live Secret
metadata and service takeover are verified. Never put the token in argv, chat,
an Assignment, a manifest or a log.

The empty router is live but intentionally not ready. Add each subscription with
a fresh device login owned by the router Pod:

```console
kubectl --context <context> --namespace agentos exec -it statefulset/quota-router \
  --container quota-router -- quota-router login <non-secret-label>
kubectl --context <context> --namespace agentos exec statefulset/quota-router \
  --container quota-router -- quota-router list
kubectl --context <context> --namespace agentos exec statefulset/quota-router \
  --container quota-router -- quota-router status
```

Show the device verification URI and one-time user code to the Captain, but no
access or refresh token. OAuth chains rotate on refresh; never copy a local Pi
or Codex auth file into the router. Readiness becomes healthy after at least one
eligible OAuth account or an explicitly enabled API-key fallback exists.

Keep `OPENAI_API_KEY` in a separate Kubernetes Secret. Enable
`QUOTA_ROUTER_ALLOW_API_KEY_FALLBACK=true` only through an approved workload
patch. The fallback is considered only when no OAuth account is eligible. It
does not substitute another model and its real OpenAI response remains visible.

## Connect a selected Agent

Patch only approved client Pods with all three values:

- label `agentos.akua.dev/quota-router-client: "true"`;
- `QUOTA_ROUTER_URL=http://quota-router.agentos.svc.cluster.local:8787`;
- `QUOTA_ROUTER_TOKEN` from `Secret/quota-router-client` key `token`.

Render the effective StatefulSet and inspect the diff. Environment changes need
a real process/Pod restart; Pi `/reload` cannot change environment. Ask before
interrupting a Mate and preserve its native session reference through the
normal recovery procedure.

When both environment values exist, the reviewed role-local Pi extension exposes
`fleet-codex` from Pi's installed Codex model catalog. It is inert otherwise.
Select `fleet-codex/<model>` explicitly through Pi's native model interface;
never rewrite the saved default or silently replace `openai-codex`.

For a Codex Crewmate, use its native provider configuration and the existing
unattended launch contract from `$agentos-harnesses`:

```console
codex -c 'model_provider="fleet-codex"' \
  -c 'model_providers.fleet-codex.name="Fleet Codex"' \
  -c 'model_providers.fleet-codex.base_url="http://quota-router.agentos.svc.cluster.local:8787/v1"' \
  -c 'model_providers.fleet-codex.env_key="QUOTA_ROUTER_TOKEN"' \
  -c 'model_providers.fleet-codex.wire_api="responses"' \
  -c 'model_providers.fleet-codex.supports_websockets=false' \
  --model <model> <reviewed-unattended-options>
```

Do not add an AgentOS Codex wrapper. The Secret-backed environment is the client
credential; the router replaces it before the upstream request. This custom
provider can expose a different native model-picker surface than ChatGPT login,
so select and verify the exact model before dispatch.

## Verify, recover and retire

Verify `/readyz`, `quota-router status`, the selected Agent environment and one
short fixed no-tool response. Record only effective provider/model, the opaque
managed account label/ID and success. `quota-axi` may provide additional
read-only provider observations; it never selects accounts or mutates the
router.

An upstream `401`, `429`, timeout or provider error is expected to reach the
harness. Inspect the native harness error, `quota-router status`, Pod/PVC state
and non-secret account list. Reauthenticate the affected opaque account with a
fresh `quota-router login`; do not delete the old chain until replacement is
verified. Do not restart an Agent merely to hide quota failure and do not add a
silent cross-account retry.

To retire the capability, first return every client to verified direct auth and
remove its router provider environment/label. Then stop the StatefulSet, revoke
or remove managed accounts and the client Secret, and ask separately before
deleting the retained PVC. A rollback that leaves either provider credentials
or an untracked client token behind is incomplete.
