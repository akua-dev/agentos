# First Mate release artifacts

A stable AgentOS release may publish three human-readable single-file
Kubernetes manifests generated directly from the reviewed Kustomize resources:

- `agentos-firstmate.yaml` grants the First Mate administration only in the
  `agentos` namespace.
- `agentos-firstmate-cluster-admin.yaml` adds cluster-wide administration for a
  developer-approved dedicated cluster.
- `agentos-postgres.yaml` creates the minimal self-hosted CloudNativePG
  database after its controller has been approved and verified.

All three First-Mate container references are replaced with the same immutable
AgentOS OCI digest and use `IfNotPresent`. The database manifest is deliberately
version-neutral; First Mate discovers and injects current compatible official
CNPG and PostgreSQL versions only if the developer selects self-hosting.
Generate the assets from the repository root:

```console
mise install
bun run release/kubernetes/render.ts \
  --image ghcr.io/akua-dev/agentos@sha256:<digest> \
  --version <semver> \
  --output dist/release
```

The tag-triggered release workflow builds the native multi-platform image,
passes its resolved digest to this renderer, and publishes all three files on
an immutable GitHub release. See the release-cut procedure in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md#stable-release-manifests). GitHub
releases are not required for an exact-commit development build. Never
hand-edit a generated manifest or reuse a release tag.
