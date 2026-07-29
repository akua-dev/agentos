---
name: agentos-fleet-upgrade
description: Orchestrate one exact published stable AgentOS release across all active persistent Mates in one Fleet. Use only from First Mate when the Captain explicitly authorizes that exact Fleet-wide scope; freeze and preflight the roster, select a Second-Mate canary, update one Mate at a time through $agentos-upgrade, stop on first failure and update First Mate last. Do not use for one Mate, dogfood, migrations, Crewmates or services.
---

# Upgrade all persistent Mates

Use native provider, PostgreSQL, Git, Kubernetes and Herdr interfaces. Pi
exposes this Skill as `/skill:agentos-fleet-upgrade`.

Load `$agentos-secondmates` for the authoritative persistent-Mate roster and
lifecycle boundary. Load `$agentos-supervision` to reconcile current work,
runtime and safe turn boundaries. Load `$agentos-upgrade` for stable release
verification and every atomic one-Mate preflight, mutation and verification.

## Establish exact Fleet authority

1. Require one exact stable semantic version and explicit Captain scope covering
   “all active persistent Mates in this Fleet.” A request for one Mate, an
   unversioned “update AgentOS” request or a general maintenance preference is
   not Fleet authority.
2. The exact Fleet instruction authorizes one frozen roster and one shared
   atomic operation for each named member. It does not require repeated
   approval for a member already inside that roster.
3. It excludes Crewmates, provisioning or retired Mates, a Mate activated after
   the snapshot, databases, migrations, Fleet AI Gateway, registries, other
   services, another Fleet, interruption of consequential work and any second
   Pod replacement required for rollback.
4. Route exact-commit dogfood through `$agentos-development`,
   `$agentos-image-builds` and `$agentos-registry`. Route a one-Mate stable
   update directly to `$agentos-upgrade`.

## Resolve once and freeze the roster

1. Use `$agentos-upgrade` to verify the release once. Record its exact version,
   tag commit, official default-branch membership, immutable image index digest,
   platform members and fixed First-Mate asset in First Mate's durable native
   session. Every member must use this same tuple. Later checks may confirm
   that tuple, but must not select or substitute a release per member.
2. Authenticate the active root First Mate from PostgreSQL. Freeze that Agent
   plus every active direct Second Mate. Record stable Agent IDs and handles;
   do not infer membership from Pod names or a terminal layout.
3. Exclude every Crewmate, provisioning or retired Mate. A newly active Second
   Mate after the snapshot is deferred and reported instead of appended.
4. Resolve each member to exactly one persistent checkout, one single-replica
   `RollingUpdate` StatefulSet, one healthy StatefulSet-owned Pod, one bound home
   PVC and one authoritative Herdr/native harness session.

## Preflight every member before mutation

For every frozen member, run the complete `$agentos-upgrade` authority and
preflight boundary against the one resolved release without changing Git,
Kubernetes or the harness. Also reconcile Task, Assignment, Inbox, provider and
runtime state far enough to prove the member is not in a consequential external
mutation and is at a safe update boundary.

Record the secret-safe evidence in First Mate's durable native session. If any
member is dirty, ambiguous, unhealthy, unbound, on an unsupported update or
pull policy, unable to pull the digest, still performing a consequential
mutation or otherwise outside the shared atomic boundary, stop before the first
mutation and report the exact blocker.

A member already matching the target checkout commit, desired and observed
release image membership, stable metadata, PVC identity, native session and
preserved installation wiring is a verified no-op. Keep it in the frozen roster
and final report, remove it from the mutation sequence and do not restart it.

## Choose and publish the serial order

If no member needs mutation, report the verified no-op Fleet result and stop.

When any Second Mate needs mutation, choose one healthy idle Second Mate at a
safe turn boundary as canary. If none is safe, wait or ask the Captain rather
than interrupting work. Freeze the remaining order before mutation:

1. the Second-Mate canary;
2. every remaining Second Mate needing mutation, one at a time; and
3. First Mate last when it needs mutation.

Present the exact handles, no-op members, deferred members and order before the
first mutation. This is a visibility boundary, not another approval request.
Never update members in parallel.

## Apply one atomic operation at a time

For the current named target, load `$agentos-upgrade` and supply only that
member of the frozen Captain-authorized roster as enclosing authority. Apply
one atomic operation with the already resolved release tuple. The shared Skill
must not enumerate, sequence or advance the roster.

Do not continue until the current target reaches the shared final verification
boundary. Record its exact checkout, release index and platform digest,
readiness, PVC, native session and preserved-wiring evidence in First Mate's
durable native session. Operate managed Second Mates directly through native
interfaces; do not ask a human to tag them, duplicate the instruction into a
separate chat or create a parallel coordination system.

On the first failure, stop. Preserve successful members as verified and leave
untouched members unchanged. Do not continue for consistency, automatically
roll back successful members or authorize a second replacement Pod. Follow the
shared recovery boundary for the failed member and report any separately
required authority.

## Update First Mate last and report

When First Mate needs mutation, first verify that every preceding member result
is recorded and no frozen-roster boundary has become contradictory, then run
its one atomic operation last. If First Mate is a verified no-op, keep the
current session and proceed directly to consolidated verification.

After a self-update, the resumed First-Mate native session must verify its own
atomic operation. In either case, load the frozen roster and recorded member
results, and reconcile each member's current Kubernetes, Git, PVC and
native-session evidence. Report one consolidated result containing the exact
release, every verified update and no-op, every deferred member and the first
failure or unverified boundary.

Only after this report may First Mate return to ordinary supervision and re-arm
its normal waits. The native session is the rollout record; create no database
table, retained state file, CLI, script, service, controller or other shadow
rollout state.
