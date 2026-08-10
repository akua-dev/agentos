# Hermes Agent through the Fleet AI Gateway

This contract covers Hermes Agent `0.20.0` from release tag `v2026.8.3` and
other approved clients that speak the OpenAI Responses API but cannot reread a
Kubernetes projected token for every request. Direct per-agent OAuth remains
the recovery path.

## Client contract

The client keeps authority over the exact model and reasoning configuration. It
sends only `POST /v1/responses` or `POST /v1/responses/compact` to a loopback
`ai-gateway-workload-proxy` sidecar. The sidecar:

- accepts no provider credential and listens on loopback only;
- rereads the kubelet-rotated `agentos-egress-authz` ServiceAccount token for
  every request;
- removes caller-supplied authorization, assignment, decision, grant, and every
  other `x-agentos-*` header, then supplies only projected identity and an
  optional validated assignment ID from sidecar-owned configuration to
  `agentgateway-openai`; W3C `traceparent` and `tracestate` correlation remain
  unchanged;
- forwards the request once, without inspecting or storing its body; and
- returns the actual upstream status, headers, and stream without retrying or
  selecting another model or account.

Agentgateway and `agentos-egress-authz`, not the sidecar, authenticate the Pod
and authorize its registered Agent or Assignment. Do not expose the loopback
listener as a Service. Do not copy an AI Gateway client Secret, OAuth file, or
operator token into the client namespace.

`GET /livez` is process-only. `GET /readyz` rereads the projected token and
returns ready only when it is present, at most 16 KiB, strict UTF-8, already
trimmed, and JWT-like. Neither endpoint contacts Agentgateway or a provider.

## Hermes 0.20.0 configuration

Hermes 0.20 supports named providers with `transport: codex_responses`, but a
configured API key is a process-lifetime value. Point the named provider at the
loopback adapter and use a non-secret placeholder; never put the projected token
in `config.yaml` or `.env`.

```yaml
model:
  provider: agentos-gateway
  default: <exact-approved-model>

providers:
  agentos-gateway:
    name: AgentOS Gateway
    api: http://127.0.0.1:8790/v1
    api_key: agentos-workload-identity-placeholder
    transport: codex_responses
    discover_models: false
    models:
      - <exact-approved-model>

agent:
  api_max_retries: 0

fallback_providers: []
fallback_model: ""
```

These fields are load-bearing for Hermes 0.20's named-provider resolver. The
input must select `provider: agentos-gateway`; the matching provider entry's
`transport: codex_responses` retains the Responses transport, and its `api`
points that transport at the loopback `/v1` base. Hermes normalizes this named
input at runtime to `provider: custom`, `api_mode: codex_responses`, and
`base_url: http://127.0.0.1:8790/v1`. Putting `provider: custom` directly in the
input falls back to Chat Completions. The checked fixture
[`hermes-ai-gateway.config.yaml`](./hermes-ai-gateway.config.yaml) is exercised
against the named input contract and the sidecar allowlist in the Gateway test
suite.

`api_max_retries: 0` and the empty fallback configuration are part of the
contract: after Hermes sends a request, it must surface the real `401`, `403`,
`429`, timeout, or provider failure rather than replaying the turn through a
route that may acquire another account. Keep auxiliary model slots direct or
configure each approved slot explicitly through the same no-retry contract;
`auto` inherits the main route.

## Pod wiring

The owning Hermes deployment supplies this wiring. AgentOS owns the adapter
binary and the governed backend topology, but does not own or apply a foreign
Hermes StatefulSet. Add the selected-client label, projected identity volume,
and loopback sidecar to the reviewed workload manifest:

```yaml
spec:
  template:
    metadata:
      labels:
        agentos.akua.dev/agentgateway-client: "true"
    spec:
      automountServiceAccountToken: false
      containers:
        - name: hermes
        - name: ai-gateway-workload-proxy
          image: <same-reviewed-agentos-image-digest-as-the-gateway-release>
          command: ["ai-gateway-workload-proxy"]
          env:
            - name: AI_GATEWAY_URL
              value: http://agentgateway-openai.agentos.svc.cluster.local:8788
            - name: AGENTOS_EGRESS_TOKEN_FILE
              value: /var/run/secrets/agentos-egress/token
            # Optional: set only from the workload owner's trusted Assignment.
            - name: AGENTOS_ASSIGNMENT_ID
              value: <exact-assignment-uuid>
          ports:
            - name: workload-proxy
              containerPort: 8790
          readinessProbe:
            httpGet:
              path: /readyz
              port: workload-proxy
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            readOnlyRootFilesystem: true
            runAsNonRoot: true
          volumeMounts:
            - name: agentos-egress-identity
              mountPath: /var/run/secrets/agentos-egress
              readOnly: true
      volumes:
        - name: agentos-egress-identity
          projected:
            defaultMode: 0440
            sources:
              - serviceAccountToken:
                  audience: agentos-egress-authz
                  expirationSeconds: 600
                  path: token
```

Use the workload's existing explicit `fsGroup` so the sidecar can read the
`0440` projection. Only the sidecar mounts that identity volume; Hermes cannot
read it. Keep the workload's dedicated ServiceAccount, register that identity
and its approved access profile through the normal AgentOS access-plane
procedure, and preserve the existing NetworkPolicy. The label grants only network
reachability to Agentgateway; it is not authorization.

## Migration from the live v0.1.24 topology

The observed pre-migration topology uses one `ai-gateway` replica with a shared
`AI_GATEWAY_TOKEN`, while Hermes uses direct in-Pod provider authentication and
has no projected egress identity. Do not mutate it in place.

1. Keep Hermes on verified direct OAuth while deploying the reviewed
   Agentgateway plus `agentos-egress-authz` topology and registering the Hermes
   workload identity/access profile.
2. Build and publish the reviewed AgentOS revision, then update the Hermes
   manifest with the exact immutable adapter image digest and projected token
   wiring. Do not copy the legacy shared token or any `ai-gateway-client` Secret.
3. Render and review the StatefulSet and NetworkPolicies. Confirm the proxy is
   loopback-only, Agentgateway is the only AI Gateway ingress, and ordinary
   Internet egress is unchanged.
4. After explicit rollout approval, start a new Hermes session with the exact
   selected model and authorize one short fixed no-tool response. Verify the
   effective provider/model and failure fidelity without reading prompts,
   responses, tokens, account IDs, or vault state.
5. Keep direct OAuth intact until that evidence is accepted. Roll back by
   restoring the prior Hermes config/workload revision; do not delete provider
   auth or retained homes as part of route rollback.
6. Retire the legacy shared-token request path only after every selected client
   has either passed the workload-identity route or returned to verified direct
   authentication. Secret removal, deployment, restart, and provider login are
   separate human approval gates.
