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
  provider: custom:agentos-gateway
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
input must select `provider: custom:agentos-gateway`; the matching provider entry's
`transport: codex_responses` retains the Responses transport, and its `api`
points that transport at the loopback `/v1` base. Hermes normalizes this named
input at runtime to the named custom provider with `api_mode: codex_responses`
and `base_url: http://127.0.0.1:8790/v1`. Putting bare `provider: custom`
directly in the input falls back to Chat Completions. The checked fixture
[`hermes-ai-gateway.config.yaml`](./hermes-ai-gateway.config.yaml) is exercised
against the named input contract and the sidecar allowlist in the Gateway test
suite.

`api_max_retries: 0` and the empty fallback configuration are part of the
contract: after Hermes sends a request, it must surface the real `401`, `403`,
`429`, timeout, or provider failure rather than replaying the turn through a
route that may acquire another account. Keep auxiliary model slots direct or
configure each approved slot explicitly through the same no-retry contract;
`auto` inherits the main route. Set `HERMES_STREAM_RETRIES=0` on the Hermes
container as shown below; this separately disables mid-stream reconnects after
partial output.

## Pod wiring

The owning Hermes deployment supplies this wiring. AgentOS owns the adapter
binary and the governed backend topology, but does not own or apply a foreign
Hermes StatefulSet. Add the selected-client label, projected identity volume,
and loopback sidecar to the reviewed workload manifest:

The current Agentgateway NetworkPolicy admits client Pods from the `agentos`
namespace, or from an already approved namespace labeled
`agentos.akua.dev/managed-by: agentos-firstmate`, only when the Pod has an
`agentos.akua.dev/agent` label. Deploy Hermes in one of those approved
namespaces and preserve that reachability label. These labels only permit
network reachability; the projected ServiceAccount token and Agentgateway
authorizer provide authentication and authorization.

```yaml
spec:
  template:
    metadata:
      labels:
        agentos.akua.dev/agent: "hermes"
        agentos.akua.dev/agentgateway-client: "true"
    spec:
      automountServiceAccountToken: false
      containers:
        - name: hermes
          env:
            - name: HERMES_STREAM_RETRIES
              value: "0"
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
          livenessProbe:
            exec:
              command:
                - /usr/bin/curl
                - --fail
                - --silent
                - --show-error
                - http://127.0.0.1:8790/livez
          readinessProbe:
            exec:
              command:
                - /usr/bin/curl
                - --fail
                - --silent
                - --show-error
                - http://127.0.0.1:8790/readyz
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

## Operator workflow

Use `$agentos-ai-gateway` for the approval, migration, rollout, verification,
rollback, and retirement workflow, including migration from the live v0.1.24
shared-token topology. This page owns only the Hermes client contract and Pod
wiring.
