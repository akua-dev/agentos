# Self-hosted PostgreSQL

This directory owns the optional in-cluster database topology. The base renders
one `postgresql.cnpg.io/v1` `Cluster` backed by CloudNativePG: PostgreSQL 18.4,
one instance, a 20 GiB PVC, data checksums, and the unprivileged `agentos`
application identity.

The single-instance base is the fastest bootstrap path, not an HA or backed-up
production topology. First Mate must explain that boundary and ask before
installing the cluster-scoped CNPG controller or creating the database.

CloudNativePG controller provenance, checksum and image digest are carried in
the AgentOS `release.json`; the PostgreSQL operand digest is part of both that
metadata and this manifest. Database objects remain authoritative only in
[`packages/database/migrations/`](../../../packages/database/migrations/).
