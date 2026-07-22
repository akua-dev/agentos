---
name: agentos-ai-gateway
description: Install, configure, inspect, recover, rotate, or retire the optional AgentOS Fleet AI Gateway for pooled Codex subscriptions and an explicit OpenAI API-key fallback. Use when a First or Second Mate considers shared AI capacity, server-owned provider OAuth, native Pi or Codex routing through the gateway, quota-aware account routing, gateway client Secrets, or gateway 401/429 failures.
---

# Operate the Fleet AI Gateway

Keep direct per-Agent provider login as the complete minimal topology and
recovery path. Recommend the AI gateway for a delegation-ready Fleet when
several approved Agents or trusted harness automations need model capacity and
the Captain accepts one additional credential authority and service lifecycle.

The gateway chooses credentials for the requested model; it never chooses a
model, queues a prompt or hides the provider response. PostgreSQL remains Fleet
coordination truth. The gateway's retained PVC owns only its OAuth vault,
observed quota, session assignments, blocks and active reservations.

Use `ai-gateway`, `AI_GATEWAY_*` and the AI-gateway client label consistently.
Never create a second StatefulSet or copy its credential vault during an
upgrade.

## Decide and inspect

1. Resolve the exact AgentOS revision, Kubernetes context, `agentos` namespace,
   intended clients and current provider authentication.
2. Inspect whether `StatefulSet/ai-gateway`, `Service/ai-gateway`,
   `Secret/ai-gateway-client`, its PVC and the selected-client NetworkPolicy
   already exist. Inspect only metadata and non-secret status; do not print
   Secret data or the vault.
3. Compare two complete paths:
   - recommended pooled capacity: the gateway owns fresh server-side Codex OAuth
     chains and selected Agent Pods receive only a Fleet client token;
   - minimal direct authentication: each Agent's native harness owns its
     credential on its PVC.
4. Reject pooled routing when the endpoint would require a public Ingress, the
   storage cannot remain single-writer, selected Pods cannot be isolated, or a
   third-party policy forbids subscription proxying. Do not claim that pooled
   personal subscription use is provider-endorsed; treat it as an explicit
   experimental Captain choice.
5. After the Captain chooses, record the capacity posture plus exact approved
   client classes in Fleet-scoped Captain state. Reuse that policy for later
   dispatch and trusted harness automation. Ask again when a client, credential
   source, cost or blast radius falls outside the recorded authority.
6. A Second Mate may inspect and report gateway state but must route Fleet-wide
   installation, account changes and shared Secret changes through First Mate
   unless its exact charter and standing authorization cover them.

Ask before installing the service, initially creating or distributing its
client Secret, starting each provider login, enabling API-key fallback,
changing an Agent's provider/environment, interrupting a live harness, deleting
an account, or removing retained state unless exact durable standing authority
covers that client and action. State the credential blast radius and whether
the action can incur provider cost.

## Install the optional service

Use the reviewed topology at
`services/ai-gateway/kubernetes`. Render and inspect it before
apply. It must remain one non-root replica, a ClusterIP without Ingress, a
retained ReadWriteOnce PVC and the selected-client NetworkPolicy.

Create a high-entropy client token in a mode-`0600` file outside Git. Pass its
path—not its value—to native kubectl, and pipe the generated Secret directly
into the API rather than rendering it to the terminal or a normal file:

```console
kubectl --context <context> --namespace agentos create secret generic ai-gateway-client \
  --from-file=token=<private-token-file> --dry-run=client --output=json | \
  kubectl --context <context> --namespace agentos apply --filename=-
kubectl --context <context> kustomize services/ai-gateway/kubernetes
kubectl --context <context> --namespace agentos apply --filename <reviewed-render>
kubectl --context <context> --namespace agentos rollout status statefulset/ai-gateway
```

Delete the private token file only after the live Secret metadata and service
takeover are verified. Never put the token value in argv, chat, an Assignment,
a manifest or a log.

The empty gateway is live but intentionally not ready. Add each subscription with
a fresh device login owned by the gateway Pod:

```console
kubectl --context <context> --namespace agentos exec -it statefulset/ai-gateway \
  --container ai-gateway -- ai-gateway login <non-secret-label>
kubectl --context <context> --namespace agentos exec statefulset/ai-gateway \
  --container ai-gateway -- ai-gateway list
kubectl --context <context> --namespace agentos exec statefulset/ai-gateway \
  --container ai-gateway -- ai-gateway status
```

Show the device verification URI and one-time user code to the Captain, but no
access or refresh token. OAuth chains rotate on refresh; never copy a local Pi
or Codex auth file into the gateway. Readiness becomes healthy after at least one
eligible OAuth account or an explicitly enabled API-key fallback exists.

Keep `OPENAI_API_KEY` in a separate Kubernetes Secret. Enable
`AI_GATEWAY_ALLOW_API_KEY_FALLBACK=true` only through an approved workload
patch. The fallback is considered only when no OAuth account is eligible. It
does not substitute another model and its real OpenAI response remains visible.

## Connect a selected Agent

Patch only explicitly approved or standing-authorized client Pods with all
three values:

- label `agentos.akua.dev/ai-gateway-client: "true"`;
- `AI_GATEWAY_URL=http://ai-gateway.agentos.svc.cluster.local:8787`;
- `AI_GATEWAY_TOKEN` from `Secret/ai-gateway-client` key `token`.

Render the effective StatefulSet and inspect the diff. Environment changes need
a real process/Pod restart; Pi `/reload` cannot change environment. Ask before
interrupting a Mate and preserve its native session reference through the
normal recovery procedure.

Pi needs no AgentOS extension. Configure its built-in `openai-codex` provider in
the Agent's persistent `~/.pi/agent/models.json`; the built-in model catalog and
Codex transport remain owned by Pi:

```json
{
  "providers": {
    "openai-codex": {
      "baseUrl": "http://ai-gateway.agentos.svc.cluster.local:8787",
      "apiKey": "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiZmxlZXQtZ2F0ZXdheSJ9fQ.placeholder",
      "headers": {
        "X-AI-Gateway-Token": "$AI_GATEWAY_TOKEN"
      }
    }
  }
}
```

The JWT-shaped value is a public, non-secret transport placeholder required for
Pi to construct Codex headers. The dedicated header carries the Secret-backed
Fleet credential; the gateway strips both before injecting the selected
upstream account. Merge this provider entry with existing `models.json` content
instead of replacing unrelated provider settings. Opening `/model` reloads the
file. Select and verify the intended `openai-codex/<model>` explicitly; do not
rewrite a saved model default. Remove this provider override to return Pi to
direct authentication.

A selected Mate may retain its direct Pi login as a recovery path while a
Codex process used by no-mistakes or another trusted automation explicitly uses
`fleet-codex`. Configure and verify that process through the same selected
client boundary; do not require an unrelated second browser login merely
because the automation uses another harness.

For a Codex Crewmate, use its native provider configuration and the existing
unattended launch contract from `$agentos-harnesses`:

```console
codex -c 'model_provider="fleet-codex"' \
  -c 'model_providers.fleet-codex.name="Fleet Codex"' \
  -c 'model_providers.fleet-codex.base_url="http://ai-gateway.agentos.svc.cluster.local:8787/v1"' \
  -c 'model_providers.fleet-codex.env_key="AI_GATEWAY_TOKEN"' \
  -c 'model_providers.fleet-codex.wire_api="responses"' \
  -c 'model_providers.fleet-codex.supports_websockets=false' \
  --model <model> <reviewed-unattended-options>
```

Do not add an AgentOS Codex wrapper. The Secret-backed environment is the client
credential; the gateway replaces it before the upstream request. This custom
provider can expose a different native model-picker surface than ChatGPT login,
so select and verify the exact model before dispatch.

## Verify, recover and retire

Verify `/readyz`, `ai-gateway status`, the selected Agent environment and one
short fixed no-tool response. Record only effective provider/model, the opaque
managed account label/ID and success. `quota-axi` may provide additional
read-only provider observations; it never selects accounts or mutates the
gateway.

An upstream `401`, `429`, timeout or provider error is expected to reach the
harness. Inspect the native harness error, `ai-gateway status`, Pod/PVC state
and non-secret account list. Reauthenticate the affected opaque account with a
fresh `ai-gateway login`; do not delete the old chain until replacement is
verified. Do not restart an Agent merely to hide quota failure and do not add a
silent cross-account retry.

To retire the capability, first return every client to verified direct auth and
remove its gateway provider environment/label. Then stop the StatefulSet, revoke
or remove managed accounts and the client Secret, and ask separately before
deleting the retained PVC. A rollback that leaves either provider credentials
or an untracked client token behind is incomplete.
