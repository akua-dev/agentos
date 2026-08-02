# AgentOS PostgreSQL-first A2A service

`agentos-a2a` is the narrow A2A v1 transport edge for AgentOS. It is an
ordinary, independently deployed Effect Platform Bun service. It is not an
Agent sidecar, harness process, task scheduler, transcript store, or Agent Pod
authority.

PostgreSQL remains authoritative. A caller must first commit the canonical
Inbox row and any Task or Assignment. `SendMessage` then carries only the exact
Inbox reference. The service re-authenticates the projected ServiceAccount
bearer with TokenReview, authorizes the exact caller/target/versioned-skill
resource through the current profile, Captain ceiling, and OpenFGA model,
verifies the committed direct hierarchy edge and active target Assignment in
PostgreSQL, and emits one best-effort PostgreSQL wake. A replay can repeat that
wake but cannot create durable state.

The supported surface is intentionally finite:

- unauthenticated Agent Cards expose target identity, the projected-bearer
  security scheme, and the presence of an authenticated extended card, but no
  operational skills;
- authenticated cards advertise only the intersection of the reviewed skill
  vocabulary, target profile, Captain ceiling, and caller authorization;
- `SendMessage` accepts only the closed reference media type with
  `returnImmediately: true`;
- `GetTask` derives a content-free delivery projection from the canonical Inbox
  receipt; and
- streaming, listing, cancellation, push configuration, artifacts, text parts,
  history, and arbitrary JSON-RPC methods are rejected.

`GET /livez` proves only process liveness. `GET /readyz` requires the service's
own projected token to pass TokenReview as the expected ServiceAccount, the
pinned OpenFGA health check to pass, and the dedicated PostgreSQL login to have
execute access to all three A2A functions. Authorization and canonical
verification are repeated at the backend even after agentgateway external
authorization; caller-provided verification headers are never trusted.

Telemetry contains only the protocol method, finite outcome, retry/timeout
flags, target and versioned skill IDs, and stable Inbox/Task/Assignment
correlations. It never emits the subject, Inbox body, prompt, brief, transcript,
Agent Card description, token, credential, tool payload, or provider/session
content. Agentgateway v1.4.1 does not extract the v1 Task state nested below
`result.task`, so this service owns that bounded signal until an upgrade passes
the same conformance again.

## Deployment

Kustomize is the deployment authority:

```sh
kubectl kustomize services/a2a/kubernetes
kubectl kustomize services/agentgateway/kubernetes/a2a
kubectl apply -k services/a2a/kubernetes
kubectl apply -k services/agentgateway/kubernetes/a2a
```

Install the pinned agentgateway v1.4.1 Kubernetes controller, CRDs, Gateway API
CRDs, and `agentgateway` GatewayClass first. Their controller image and both OCI
chart digests are pinned in `services/agentgateway/release.json`; the chart is
an upstream input, while the resources above remain the reviewed AgentOS source
of truth. Provision the externally managed `agentos-a2a-tls` certificate Secret
for the HTTPS Gateway.

The base target ConfigMap contains `[]` and is safe but advertises no Agents.
An environment overlay replaces `targets.json` with one or more closed entries:

```json
[
  {
    "targetAgentId": "22222222-2222-4222-8222-222222222222",
    "targetHandle": "platform-mate",
    "description": "Owns the reviewed platform domain",
    "agentVersion": "2026.08.02",
    "skillVocabulary": [
      {
        "id": "repository.implementation@v1",
        "name": "Repository implementation",
        "description": "Implements reviewed repository changes",
        "tags": ["repository", "implementation"]
      }
    ],
    "reviewedSkillIds": ["repository.implementation@v1"],
    "profileSkillIds": ["repository.implementation@v1"],
    "ceilingSkillIds": ["repository.implementation@v1"]
  }
]
```

The Deployment expects the file-mounted `agentos-a2a-database` Secret key
`database-url`, the `openfga-admin` Secret key `preshared-key`, and the
bootstrap-generated `openfga-deployment` ConfigMap. The database URL must use a
dedicated unprivileged login. After every migration the schema owner runs:

```sql
SELECT agentos.configure_a2a_service_privileges('agentos_a2a');
```

That function strips table, sequence, schema, and unrelated-function access,
then grants only workload identity snapshots plus the content-free A2A verify,
wake, and projection functions. The NetworkPolicy restricts inbound service
traffic to the selected Gateway Pods and intentionally declares no egress
policy; ordinary Internet access elsewhere in the Fleet remains direct.

## Verification

```sh
bunx vitest run services/a2a/tests \
  packages/agentos/src/access/tests/a2a-policy.effect.test.ts \
  database/tests/a2a-delivery.effect.test.ts
bun run --cwd services/openfga model:check
bun run effect:check
bun run typecheck
kubectl kustomize services/a2a/kubernetes
kubectl kustomize services/agentgateway/kubernetes/a2a
```

The destructive TokenReview/OpenFGA/PostgreSQL/gateway/outage matrix is owned
by issue #130; this service keeps the PostgreSQL listener and Herdr recovery
path sufficient when every live A2A component is unavailable.
