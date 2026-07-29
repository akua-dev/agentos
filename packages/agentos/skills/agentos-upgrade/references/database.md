# Released database phase for a stable upgrade

Use this procedure only from `$agentos-upgrade` after the selected named Mate
or complete frozen Fleet roster has passed its release, runtime, source,
workload, PVC and native-session preflight. This reference owns upgrade
sequencing only. Load `$agentos-database` and follow its released migration
mechanics rather than reproducing them here.

## Inspect the exact release and Fleet

1. From the same verified release tuple and read-only target-release source root
   resolved by the enclosing upgrade, require the version-neutral database
   manifest, ordered `database/migrations/` assets and Drizzle journal. Stop if
   the release database assets are absent, ambiguous or from another revision.
2. Resolve the one PostgreSQL database for the current Fleet, the authenticated
   root First Mate and the Fleet-owner login that owns the released AgentOS
   schema. Inspect the server identity, current migration journal, checksums
   and pending release migrations without changing them.
3. Reject a second database, another Fleet, a separate migrator identity,
   PostgreSQL or CloudNativePG provisioning or upgrade, credential creation,
   role or grant changes, weakened TLS, an improvised down-migration or an
   arbitrary Fleet-row repair.

An exact instruction to upgrade the selected Mate or Fleet to this stable
release includes preparing the release-pinned migration tooling in its
documented content-addressed PVC workspace and applying this release's ordered
pending migrations to the current Fleet. Do not request another Captain
approval for those two operations.

If a Second Mate is performing an authorized self-upgrade and any migration is
pending, route the already-authorized database phase to First Mate. Wait for
First Mate to return exact verified migration evidence before continuing the
named self-update. This changes the execution identity, not the approved
version or scope, and is not another approval request.

## Apply once before workload mutation

If no migration is pending, record a verified database no-op containing the
release identity, journal and checksum evidence, then return to the enclosing
upgrade.

Otherwise:

1. Require the authenticated root First Mate and Fleet-owner database login.
2. From `<target-release-source-root>/database`, use `$agentos-database` to run
   `AGENTOS_IMPLEMENTATION_ROOT=<target-release-source-root> mise run
   database:prepare`, then use its printed path to apply the selected
   release's pinned tooling and ordered pending chain through Drizzle. The
   explicit root keeps preparation on the verified target release rather than
   the active checkout. Never invoke a migration once per Mate.
3. Verify the resulting journal and checksums, confirm
   `agentos.current_agent_id()` resolves the single active root First Mate for
   the Fleet-owner session, and run the selected release's implemented
   security checks.
4. Record the exact applied range and verification result in the enclosing
   durable native Pi session. Create no upgrade table, migration marker or
   parallel state file.
5. Recheck the named target or complete frozen roster against PostgreSQL,
   Kubernetes, Git, PVC and native-session truth before the first workload
   mutation. Stop on any changed membership, ownership, active work or runtime
   boundary that invalidates the earlier preflight.

On migration failure, preserve the exact journal and every committed migration,
report the first failed or unverifiable boundary and stop before replacing a
Mate. Do not retry through another identity, edit an applied migration,
improvise SQL, weaken a released invariant or infer authority to repair legacy
Fleet rows. After a separately authorized repair, resume only from the first
incomplete released migration and repeat all verification.
