# Self-hosted PostgreSQL

This directory owns the in-cluster database shape. The version-neutral base
renders one `postgresql.cnpg.io/v1` `Cluster` backed by CloudNativePG: one
instance, a 20 GiB PVC, data checksums, and the unprivileged `agentos`
application identity. An external PostgreSQL endpoint is an equally supported
topology and uses the same SQL contract.

The single-instance base is the fastest bootstrap path, not an HA or backed-up
production topology. First Mate must explain that boundary and ask before
installing the cluster-scoped CNPG controller or creating the database.

First Mate discovers the newest stable official CloudNativePG release compatible
with the selected Kubernetes server and the newest stable supported PostgreSQL
operand at installation time. It verifies their provenance, asks for approval,
and injects the operand's `tag@sha256` into an ephemeral copy of this manifest.
Third-party versions are deliberately not pinned to an AgentOS release.
Database objects remain authoritative only in
[`packages/database/migrations/`](../../../packages/database/migrations/).
First Mate applies them with the generated application/owner login; that same
identity becomes the automatically registered Fleet root. No separate database
migrator is part of the initial topology.
