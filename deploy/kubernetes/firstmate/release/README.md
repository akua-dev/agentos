# First Mate release artifacts

Each AgentOS release publishes two single-file Kubernetes manifests generated
from the reviewed Kustomize resources:

- `agentos-firstmate.yaml` grants the First Mate administration only in the
  `agentos` namespace.
- `agentos-firstmate-cluster-admin.yaml` adds cluster-wide administration for a
  developer-approved dedicated cluster.

Every container reference is replaced with the same immutable OCI digest and
uses `IfNotPresent`. Generate the assets from `deploy/kubernetes/`:

```console
mise install
mise run release:render -- \
  --image ghcr.io/akua-dev/agentos@sha256:<digest> \
  --version <semver> \
  --output ../../dist/release
```

The renderer also writes `release.json`, the agent-readable selection surface.
Publish all three files on an immutable GitHub release. Never hand-edit a
generated manifest or reuse a release tag.
