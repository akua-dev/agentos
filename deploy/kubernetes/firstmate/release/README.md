# First Mate release artifacts

Each AgentOS release publishes three single-file Kubernetes manifests generated
from the reviewed Kustomize resources:

- `agentos-firstmate.yaml` grants the First Mate administration only in the
  `agentos` namespace.
- `agentos-firstmate-cluster-admin.yaml` adds cluster-wide administration for a
  developer-approved dedicated cluster.
- `agentos-postgres.yaml` creates the minimal self-hosted CloudNativePG
  database after its controller has been approved and verified.

All three First-Mate container references are replaced with the same immutable
AgentOS OCI digest and use `IfNotPresent`. The database manifest is deliberately
version-neutral; First Mate discovers and injects current compatible official
CNPG and PostgreSQL versions only if the developer selects self-hosting. Generate the assets from
`deploy/kubernetes/`:

```console
mise install
mise run release:render -- \
  --image ghcr.io/akua-dev/agentos@sha256:<digest> \
  --version <semver> \
  --output ../../dist/release
```

The renderer also writes `release.json` with the immutable AgentOS image and
asset names. Publish all four files on an immutable GitHub release. Never hand-edit a
generated manifest or reuse a release tag.
