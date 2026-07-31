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
plus canonical `codex-router` SQLite session assignments, quota or transient
blocks and active reservations. Bounded quota observations remain process-local
and refresh after restart. The vault's `needsReauth` flag is the single
authentication-eligibility authority and is reconciled into router state after
a fresh Gateway-owned login.

Use `ai-gateway`, `AI_GATEWAY_*` and the AI-gateway client label consistently.
Never create a second StatefulSet or copy its credential vault during an
upgrade.

The pre-release identity replacement is intentionally breaking. Do not apply
this topology over an existing differently named experimental gateway: there
is no automated PVC or OAuth-vault migration. Return its clients to verified
direct authentication, retire the old topology under the Captain's authority,
then install and authenticate this gateway fresh.

## Choose the capacity posture

Evaluate the least distributed complete posture first:

| Order | Posture                                   | Use when                                                                            | Capacity and telemetry authority                                                                                                  |
| ----- | ----------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **Direct per-Agent OAuth**                | One Agent, independent credentials, or recovery                                     | Each native harness owns its subscription; AgentOS observes the client operation                                                  |
| 2     | **In-cluster multi-subscription Gateway** | Several approved Agents should share quota-aware subscription capacity              | One Fleet AI Gateway owns the pool and routing; AgentOS OpenTelemetry owns the complete in-cluster view                           |
| 3     | **Mixed in-cluster routing**              | Mates should retain direct auth while selected workers or automation share capacity | Direct harnesses and the Gateway own separate credential boundaries; AgentOS observes both                                        |
| 4     | **External Cloudflare Worker**            | The same deliberately external router must also serve clients outside AgentOS       | The Worker owns its separate pool and router telemetry; AgentOS observes only its clients unless an explicit export is configured |

For an AgentOS-only Fleet, posture 2 or 3 is stronger than posture 4: Agents
can operate the Gateway with native Kubernetes, no inference path leaves the
cluster before reaching OpenAI, and the Fleet-local Collector receives the
full privacy-bounded trace. Posture 4 is an exceptional integration described
last, not an upgrade to the in-cluster service.

The OpenAI API-key fallback is not a multi-subscription posture. It remains a
separately approved last-resort credential source for the in-cluster Gateway.

## Decide and inspect

1. Resolve the exact AgentOS revision, Kubernetes context, `agentos` namespace,
   intended clients and current provider authentication.
2. Inspect whether `StatefulSet/ai-gateway`, `Service/ai-gateway`,
   `Secret/ai-gateway-client`, its PVC and the selected-client NetworkPolicy
   already exist. Inspect only metadata and non-secret status; do not print
   Secret data or the vault.
3. Compare the four complete postures above. For pooled capacity inside an
   AgentOS Fleet, prefer the in-cluster Gateway or mixed posture. Keep direct
   native authentication available for at least one approved recovery path.
4. Reject pooled routing when the endpoint would require a public Ingress, the
   storage cannot remain single-writer, selected Pods cannot be isolated, or a
   third-party policy forbids subscription proxying. Do not claim that pooled
   personal subscription use is provider-endorsed; treat it as an explicit
   experimental Captain choice.
5. After the Captain chooses, record the capacity posture and non-secret client
   classes in the owning Mate's private context through `$agentos-memory` as
   fallible guidance for later dispatch and trusted harness automation. Record
   exact approval or coupled state changes through Inbox with
   `$agentos-decisions`; memory never grants authority. Ask again when a
   client, credential source, cost or blast radius falls outside the exact
   recorded authority.
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
# Repeat this login once for every approved subscription in the pool.
kubectl --context <context> --namespace agentos exec -it statefulset/ai-gateway \
  --container ai-gateway -- ai-gateway login <non-secret-label>
kubectl --context <context> --namespace agentos exec statefulset/ai-gateway \
  --container ai-gateway -- ai-gateway list
kubectl --context <context> --namespace agentos exec statefulset/ai-gateway \
  --container ai-gateway -- ai-gateway status
```

Show the device verification URI and one-time user code through the
authenticated Captain surface after the exact login is authorized; do not
force a terminal attachment merely to read those two interactive instructions.
Keep them out of durable work records and generated artifacts, and show no
access or refresh token. OAuth chains rotate on refresh; never copy a local Pi
or Codex auth file into the gateway. Readiness becomes healthy after at least
one eligible OAuth account or an explicitly enabled API-key fallback exists.
After every login, inspect the bounded account list and status before starting
the next login. Use a unique non-secret operational label for each managed
slot. Do not reuse one provider account in two Gateway slots or split the same
refresh chain between independent routers.

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

The default distribution ships one additive client patch for each workload:

| Client      | Base                                                           | Optional patch                                                                           | StatefulSet          |
| ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------- |
| First Mate  | `packages/agentos/resources/roles/firstmate/kubernetes/base`   | `packages/agentos/resources/roles/firstmate/kubernetes/patches/ai-gateway-client.yaml`   | `agentos-firstmate`  |
| Second Mate | `packages/agentos/resources/roles/secondmate/kubernetes/base`  | `packages/agentos/resources/roles/secondmate/kubernetes/patches/ai-gateway-client.yaml`  | `agentos-secondmate` |
| Crewmate    | `packages/agentos/resources/crewmates/default/kubernetes/base` | `packages/agentos/resources/crewmates/default/kubernetes/patches/ai-gateway-client.yaml` | `agentos-crewmate`   |

Compose the approved client's base and patch in its reviewed per-Agent
Kustomize overlay. For example, the First Mate overlay contains:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - <agentos-checkout>/packages/agentos/resources/roles/firstmate/kubernetes/base
patches:
  - path: <agentos-checkout>/packages/agentos/resources/roles/firstmate/kubernetes/patches/ai-gateway-client.yaml
    target:
      group: apps
      version: v1
      kind: StatefulSet
      name: agentos-firstmate
```

Use the exact base, patch, and StatefulSet from the table for Second Mate or
Crewmate. Render the overlay with
`kubectl --context <context> kustomize --load-restrictor LoadRestrictionsNone
<reviewed-client-overlay>` and apply that reviewed render through the Fleet's
normal native Kubernetes workflow.

Posture 2 composes the patch for every approved pooled client. Posture 3
composes it only for selected workers or trusted automation and leaves the
other Mates' workload plus native harness authentication unchanged. A workload
without the patch cannot pass the Gateway NetworkPolicy and receives neither
Gateway environment variable.

Render the effective StatefulSet and inspect the diff. Environment changes need
a real process/Pod restart; Pi `/reload` cannot change environment. Ask before
interrupting a Mate and preserve its native session reference through the
normal recovery procedure.

Configure Pi's built-in `openai-codex` provider in the Agent's persistent
`~/.pi/agent/models.json`; the built-in model catalog and Codex transport remain
owned by Pi. The shared AgentOS session-lifecycle extension independently adds
server-side compaction while preserving that transport; its artifact and
fallback contract is documented in [`ARCHITECTURE.md`](../../../../ARCHITECTURE.md):

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

### Gateway-only First Mate recovery

When a direct `pi -ne` control succeeds but First Mate fails through the
Gateway, change only the Gateway client boundary:

1. Preserve the current `~/.pi/agent/models.json` and effective StatefulSet
   render as rollback evidence without recording Secret values.
2. Remove only the `openai-codex` Gateway provider override from
   `models.json`, then select the native direct provider. Do not remove the
   `@akua-dev/agentos` package or its `agentos-observability`, `mate-memory`,
   `openai-server-compaction`, background-task, or supervision registrations.
3. Remove `AI_GATEWAY_URL`, `AI_GATEWAY_TOKEN`, and the
   `agentos.akua.dev/ai-gateway-client` label only from First Mate's workload
   patch. Keep the standard `OTEL_*` environment unchanged.
4. Keep `AGENTOS_OPENAI_SERVER_COMPACTION_ENABLED` unset or true so portable
   summary plus direct-provider server compaction remains active and observable.
5. Restart only the First Mate Pod after rendering the exact patch, resume its
   native session, verify the direct provider/model, and run one short fixed
   no-tool response. Compare the same fresh/resumed session matrix before
   attributing the fault to the Gateway.

This recovery does not disable a generic “Mate AI extension”: the Gateway is a
provider transport override, while AgentOS behavior remains independently
loaded through the normal Pi extension entrypoint.

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

## External Cloudflare Worker

Use this final posture only when the Captain deliberately chooses one
externally hosted `codex-router` Worker as a separate capacity authority,
normally because non-AgentOS clients must use it too. An AgentOS-only Fleet
should use the in-cluster Gateway instead.

Before connecting any Agent:

1. Verify the exact `akua-dev/codex-router` release supports standalone direct
   Cloudflare egress, subscription OAuth, the AgentOS correlation-header
   boundary, and byte-preserving Responses streaming. Do not infer support from
   an OpenAI-compatible URL.
2. Keep the Worker's OAuth pool and routing state separate from the in-cluster
   Gateway. Never share one refresh chain between both authorities.
3. Never route the Worker into `Service/ai-gateway`, route the in-cluster
   Gateway through the Worker, or expose the Fleet Gateway with an Ingress.
4. Give a selected Pi client the external HTTPS base URL and
   `X-AI-Router-Token: $AI_GATEWAY_TOKEN`; give native Codex the external
   `/v1` base URL with `env_key="AI_GATEWAY_TOKEN"`. Keep the Secret-backed
   environment and explicit provider/model verification from the in-cluster
   procedure.
5. Treat Cloudflare Workers Observability as the router's default log and trace
   view. Native Workers logs and traces are available on Free with their
   documented event and retention limits. External OTLP export is a separate
   Workers Paid feature. AgentOS's Collector remains authoritative for the
   in-cluster client spans; do not claim one joined trace until deployed
   propagation evidence proves it.
6. Preserve privacy-safe AgentOS operation and attempt identifiers only through
   the Worker's reviewed bounded correlation contract. Never export prompts,
   response bodies, credentials, headers, provider account identity, or
   arbitrary errors.

See the official Cloudflare documentation for
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
[Workers Traces](https://developers.cloudflare.com/workers/observability/traces/),
[OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/),
and current
[trace-propagation limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/).
