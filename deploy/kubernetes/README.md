# Kubernetes assets

Versioned resources in this directory are the executable Kubernetes contract.
Bootstrap and runtime skills may apply only assets present in the selected immutable AgentOS release.
Every behavior change requires a render or lifecycle test; ambiguous ownership must fail closed.

Runtime images copy the release root `mise.toml` to `/etc/mise/config.toml` and
`mise.lock` to `/etc/mise/mise.lock`, but keep the tool installations in the
agent's persistent home. The init boundary installs only the startup-critical
locked tools. Mise shims remain on `PATH` for every process so repository-local
configuration resolves from each agent's current worktree.

The first executable runtime is in [`firstmate/`](firstmate/). Its base grants
the First Mate namespace-wide administration. The `cluster-admin` overlay is
only for a developer-approved dedicated cluster and must never be applied as an
implicit bootstrap default.
