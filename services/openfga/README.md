# AgentOS OpenFGA authorization store

This service owns the immutable `agentos-access-v1` OpenFGA model and the private, highly available runtime used by AgentOS provider-egress authorization. It is a policy decision point, not a credential store, proxy, or general Internet gateway.

## Released topology

[`release.json`](./release.json) pins OpenFGA `v1.18.1` by multi-architecture image-index digest, its `v1.17.1` upgrade predecessor, PostgreSQL `18.4` for disposable recovery conformance, and the SHA-256 of the generated model artifact. [`model/agentos-access-v1.json`](./model/agentos-access-v1.json) is generated from the typed source and cannot drift: `bun run --cwd services/openfga model:check` verifies byte equality.

The owned [Kustomize topology](./kubernetes/) contains:

- one dedicated three-instance CloudNativePG cluster and database named `openfga`; OpenFGA tuples never share AgentOS workflow tables;
- one release-named migration Job that must finish before the binary rollout;
- two OpenFGA replicas, rolling with zero unavailable Pods, topology spread, a PodDisruptionBudget, native database health, and semantic authorization readiness;
- a bootstrap-only Service with `publishNotReadyAddresses: true`, avoiding a readiness/bootstrap deadlock;
- one version-named, retry-safe bootstrap Job that creates or reuses the exact immutable model, establishes a canonical health tuple, verifies it with `HIGHER_CONSISTENCY`, and publishes only store/model IDs to `ConfigMap/openfga-deployment`;
- ingress selection for explicitly labelled core clients, with no public Ingress and no egress policy; and
- a volume-snapshot backup configuration that prefers a standby. The target cluster must provide CSI `VolumeSnapshot` support and a default or explicitly patched snapshot class before backups are scheduled.

The OpenFGA preshared key is an administrative credential. The manifests reference `Secret/openfga-admin` but deliberately do not create it. Only the OpenFGA runtime, semantic-readiness sidecar, bootstrap Job, and later core authorizer may receive it. First Mate, Second Mates, Crewmates, and their namespaces must not mount it. Provision the Secret through the approved secret-manager workflow. Its `preshared-key` bytes must contain no leading or trailing whitespace: OpenFGA reads the value from an environment variable while AgentOS reads the same exact bytes from a mounted file and rejects whitespace-altered input.

For a disposable development cluster, generate a newline-free protected file and create the Secret from that file rather than a command-line literal:

```bash
umask 077
openssl rand -hex 32 | tr -d '\n' > /tmp/openfga-preshared-key
kubectl create secret generic openfga-admin -n agentos \
  --from-file=preshared-key=/tmp/openfga-preshared-key
```

## First install

Install CloudNativePG before these resources. Version `1.29.1` is the reviewed operator line for this topology. Then create the `agentos` namespace and the `openfga-admin` Secret before starting the phases below.

Run each phase explicitly so database migration is an observed gate:

```bash
kubectl apply -n agentos -f services/openfga/kubernetes/postgres.yaml
kubectl wait -n agentos --for=condition=Ready cluster/openfga-postgres --timeout=10m

kubectl apply -n agentos -f services/openfga/kubernetes/migration-job.yaml
kubectl wait -n agentos --for=condition=Complete job/openfga-migrate-v1-18-1 --timeout=10m

kubectl apply -n agentos \
  -f services/openfga/kubernetes/serviceaccounts.yaml \
  -f services/openfga/kubernetes/rbac.yaml \
  -f services/openfga/kubernetes/services.yaml \
  -f services/openfga/kubernetes/deployment.yaml \
  -f services/openfga/kubernetes/poddisruptionbudget.yaml \
  -f services/openfga/kubernetes/networkpolicy.yaml

kubectl apply -n agentos -f services/openfga/kubernetes/bootstrap-job.yaml
kubectl wait -n agentos --for=condition=Complete \
  job/openfga-bootstrap-agentos-access-v1 --timeout=10m
kubectl rollout status -n agentos deployment/openfga --timeout=10m
```

The root Kustomization is for subsequent convergence and rendering. Its Jobs and clients are retry-safe, but initial installation still uses the observed phases above.

Verify the deployed pin without reading any Secret:

```bash
kubectl get -n agentos configmap/openfga-deployment \
  -o jsonpath='{.data.store-id}{"\n"}{.data.authorization-model-id}{"\n"}{.data.model-version}{"\n"}'
kubectl get -n agentos pods -l app.kubernetes.io/name=openfga
kubectl get -n agentos cluster/openfga-postgres
```

## Authorization and consistency behavior

All tuple commands and checks pin both store ID and immutable authorization-model ID. Tuple batches are transactional. Duplicate writes and missing deletes are ignored only when their contents are identical, making retries safe without allowing a different condition to replace an existing tuple silently. A condition change must be expressed as an intentional atomic delete/write plan; ambiguous replacement fails closed.

Ordinary reads may later use latency-oriented consistency where their SLO permits it. Security-sensitive acknowledgements, bootstrap, readiness, ceiling shrink, binding revocation, and profile mutation use `HIGHER_CONSISTENCY`. OpenFGA query caches remain disabled in this release. A mutation is not reported complete until its expected decision has been observed strongly.

AgentOS' closed, typed compiler calculates the finite Fleet/profile/Captain-ceiling intersection before tuple mutation. It emits a direct `allow_<capability>` relation only for the same immutable Mate or Assignment, exact Fleet, canonical provider resource, and environment when the binding is active, the profile rate is enabled and within the ceiling rate, and every scope matches. The final grant's active window starts at the later of binding creation and ceiling activation and ends at the earliest binding, profile, or ceiling expiry. Profile, ceiling, and Fleet tuples remain alongside that decision tuple for audit and version history. OpenFGA stores the immutable result and is the strongly checked decision point; this design does not depend on a recursive runtime intersection to make a security decision.

## Upgrade and rollback

Every server upgrade follows this order:

1. pin and review a new image index, predecessor, and upstream configuration/chart diff;
2. run `bun run --cwd services/openfga conformance:upgrade`, which populates the predecessor, takes a custom-format backup, migrates the same database to the candidate, restores the backup into a fresh database, migrates it, and reruns the model suite at every stage;
3. take and verify a production CloudNativePG backup; retain it outside the failure domain being upgraded;
4. apply and wait for the new version-named migration Job;
5. canary one runtime Pod, verify native and semantic readiness, then allow the zero-unavailable rollout; and
6. run the new version-named model bootstrap Job only after the server rollout is healthy.

Authorization models are immutable and remain addressable by ID. `openfga-deployment` records the prior ID whenever bootstrap publishes a new model. A model-only rollback first runs the canonical higher-consistency check against that prior ID, then atomically restores it as `authorization-model-id`; consumers hot-reload the ConfigMap. Do not delete model history.

A binary/database rollback starts from the verified pre-upgrade backup in a fresh CloudNativePG cluster; do not assume a newer schema is readable by an older binary. Cut over only after the prior binary, pinned model, semantic readiness, and model conformance all pass. The official OpenFGA guidance confirms that models are immutable and checks should pin the model ID: [immutable models](https://openfga.dev/docs/getting-started/immutable-models), [consistency](https://openfga.dev/docs/interacting/consistency), and [tuple updates](https://openfga.dev/docs/getting-started/update-tuples). CloudNativePG recovery creates a new cluster rather than overwriting the failed one: [backup](https://cloudnative-pg.io/docs/1.29/backup/) and [recovery](https://cloudnative-pg.io/docs/1.29/recovery/).

## Failure triage

- Native `/healthz` failure means the OpenFGA process or PostgreSQL path is unavailable.
- Semantic `/readyz` failure with native health means the deployment ConfigMap is absent/invalid, the pinned model cannot be checked, the canonical tuple is missing, or authorization returned deny.
- A failed migration Job blocks rollout. Inspect its status and OpenFGA logs, restore or repair the database, and rerun only the reviewed version-named Job.
- A failed bootstrap Job leaves runtime Pods not ready by design. It may be safely retried; stores, models, tuples, and ConfigMap publication are idempotent.
- Never debug by printing the preshared key, bearer headers, tuple condition context, or upstream response bodies. Client errors expose only operation, stable code, and HTTP status.

## Why Kustomize, not the upstream Helm chart

The upstream chart remains useful review input for defaults and release changes, but it is not AgentOS' deployment authority. AgentOS needs an explicit CNPG migration gate, a dynamic model bootstrap, semantic sidecar readiness, narrowly scoped bootstrap RBAC, two Services to break the bootstrap/readiness cycle, its own NetworkPolicy/PDB/topology contract, and immutable AgentOS image wiring. Owned Kustomize manifests keep those security boundaries visible and testable. Helm would template them, not remove their operational complexity.

## Reproduce

```bash
bun run --cwd services/openfga model:check
bun run --cwd services/openfga test

# Against a disposable running OpenFGA:
OPENFGA_TEST_URL=http://127.0.0.1:8080 \
  bun run --cwd services/openfga conformance:model

# Requires Docker; creates and removes only uniquely named disposable resources:
bun run --cwd services/openfga conformance:upgrade
```
