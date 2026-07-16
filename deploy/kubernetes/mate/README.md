# Shared Mate runtime

This directory contains the released runtime used by persistent First and
Second Mates. The role directories supply their own `AGENTS.md` and Mise task
names; the runtime supplies common home preparation, Pi defaults, Herdr launch,
health behavior and deterministic Second-Mate manifests.

Trusted, explicitly approved workers may use the separate
[`crewmate:spawn`](../crewmate/README.md) primitive inside a Mate pod. It shares
the Mate's security boundary and is not the default per-Agent-pod topology.

`render-secondmate.ts` requires an immutable AgentOS image digest, one
provisioned Agent UUID, a Kubernetes-safe handle, an explicit namespace, a
password-free PostgreSQL URL and the name of an already approved Secret whose
`pgpass` key belongs to that Agent. It renders a ServiceAccount, headless
Service and StatefulSet with a retained PVC. It does not create credentials,
database roles, RBAC bindings or public endpoints.

Run it from the First Mate working directory:

```console
mise run mate:render -- \
  --handle delivery-second \
  --agent-id 20000000-0000-4000-8000-000000000002 \
  --image ghcr.io/akua-dev/agentos@sha256:<digest> \
  --version 0.1.0 \
  --namespace agentos \
  --database-url postgresql://runtime_delivery_second@postgres.example:5432/agentos \
  --database-secret delivery-second-postgres \
  --output /tmp/delivery-second.yaml
```

The prepare init container copies only the mounted `pgpass` key into the
Agent-owned PVC as `~/.pgpass` with mode `0600`. Pi login and native session
state remain in that same home and survive Pod replacement.
