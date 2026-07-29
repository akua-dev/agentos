---
name: agentos-upgrade
description: Upgrade one persistent AgentOS Mate or, from First Mate with exact Captain authority, every active persistent Mate in one Fleet to an exact published stable release, including its run-once released database migrations. Use for stable First- or Second-Mate updates, resumed post-replacement verification, and authorized rollback boundaries. Do not use for dogfood, Crewmates, provisioning, retired Mates, services, or another Fleet.
---

# Upgrade AgentOS

Use native provider, Git, Kubernetes, Herdr, PostgreSQL, registry and PVC
interfaces. Do not add a harness command, AgentOS wrapper, rollout service,
controller or shadow state. Load `$agentos-runtime` before inspecting or
changing Kubernetes or Herdr.

## Establish exact authority and scope

1. Require one exact published stable semantic version and either one named
   persistent Mate or every active persistent Mate in the current Fleet.
2. If the Captain requests only an AgentOS update, resolve and present the
   newest stable candidate read-only, then obtain confirmation of the exact
   version and scope before mutation. Skip that confirmation only when an exact
   durable standing authorization already supplies both.
3. Resolve the authenticated Mate role and reject ambiguous, retired or
   unauthenticated identity before mutation.
4. For one named Mate:
   - First Mate may update itself or one managed persistent Mate inside exact
     authority.
   - Second Mate may update only itself under exact Captain authority delivered
     directly or through First Mate consistently with its charter.
   - Read both [the complete one-Mate procedure](references/one-mate.md) and
     [the released database phase](references/database.md) before preflight or
     mutation.
5. For every active persistent Mate in the Fleet:
   - require exact Captain authority covering that whole scope;
   - require the authenticated caller to be the active root First Mate;
   - read [the complete one-Mate procedure](references/one-mate.md),
     [the released database phase](references/database.md) and
     [the complete Fleet procedure](references/fleet.md) before preflight or
     mutation; and
   - let the Fleet procedure select each member while the one-Mate procedure
     remains the atomic operation.
6. Reject every other scope. Never infer Fleet authority from general
   maintenance intent, a version preference, package availability or access to
   native tools.

The exact stable-upgrade instruction includes the selected release's pinned
migration-tool preparation and ordered pending AgentOS migrations on the same
Fleet; the database reference applies them once through `$agentos-database`
before workload mutation without another Captain approval. It does not
authorize database or CloudNativePG topology changes, credential or login-role
creation, grants outside released migrations, arbitrary Fleet-row repair,
down-migration, exact-commit dogfood, release publication, merge, RBAC change,
dirty-state removal, another Fleet, Crewmates, provisioning or retired Mates,
services, or retirement of a PVC, session, Agent or rollback reference.

Route exact-commit dogfood through `$agentos-development`,
`$agentos-image-builds` and `$agentos-registry`. Stop at every unverified
authority, release, database, runtime or recovery boundary rather than
broadening the operation.
