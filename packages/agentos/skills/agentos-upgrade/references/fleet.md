# Stable upgrade for one Fleet

Use this procedure only after `$agentos-upgrade` authenticates the active root
First Mate and verifies exact Captain authority for one stable version across
every active persistent Mate in the current Fleet. Read the complete one-Mate
and released-database references with this file. The one-Mate reference remains
the atomic operation for every selected member; the database reference runs
once for the Fleet.

## Contents

- [Resolve once and freeze the roster](#resolve-once-and-freeze-the-roster)
- [Preflight every member before mutation](#preflight-every-member-before-mutation)
- [Apply the released database phase once](#apply-the-released-database-phase-once)
- [Choose and publish the serial order](#choose-and-publish-the-serial-order)
- [Apply one atomic operation at a time](#apply-one-atomic-operation-at-a-time)
- [Update First Mate last and report](#update-first-mate-last-and-report)

Load `$agentos-secondmates` for the authoritative persistent-Mate roster and
lifecycle boundary. Load `$agentos-supervision` to reconcile current work,
runtime and safe turn boundaries.

The exact Fleet instruction includes the selected release's ordered pending
AgentOS migrations on this Fleet. It excludes Crewmates, provisioning and
retired Mates, a Mate activated after the snapshot, database or CloudNativePG
topology, credentials, roles or grants outside released migrations, arbitrary
data repair, down-migration, Fleet AI Gateway, registries, other services,
another Fleet, interruption of consequential work, and a second Pod replacement
required for rollback.

## Resolve once and freeze the roster

1. Use the one-Mate reference to verify the release once. Record its exact
   version, tag commit, official default-branch membership, immutable image
   index digest, platform members and fixed First-Mate asset in First Mate's
   durable native Pi session. Every member must use this tuple. Later checks
   may confirm it but never substitute another release.
2. Authenticate the active root First Mate from PostgreSQL. Freeze that Agent
   plus every active direct Second Mate, recording stable Agent IDs and handles.
   Do not infer membership from Pod names or terminal layout.
3. Exclude every Crewmate, provisioning or retired Mate. Defer and report a
   Second Mate activated after the snapshot instead of appending it.
4. Resolve each frozen member to exactly one persistent checkout, one
   single-replica `RollingUpdate` StatefulSet, one healthy StatefulSet-owned
   Pod, one bound home PVC and one authoritative Herdr/native Pi session.
   Resolve and secret-safely render that member's installation-owned
   declarative source when one exists.

## Preflight every member before mutation

For every frozen member, run the complete one-Mate authority and preflight
boundary against the resolved release without changing Git, Kubernetes or the
harness. Reconcile Task, Assignment, Inbox, provider and runtime state far
enough to prove the member is not performing a consequential external mutation
and is at a safe update boundary.

Record secret-safe evidence in First Mate's durable native Pi session. If any
member is dirty, ambiguous, unhealthy, unbound, on an unsupported update or
pull policy, unable to pull the digest, still performing a consequential
mutation, has unexplained declarative/live drift or is otherwise outside the
shared atomic boundary, stop before the first mutation and report the blocker.

A member already matching the target checkout and image-seed commits, desired
and observed release image membership, installation-owned declarative source
when present, stable metadata, PVC identity, native session and preserved
installation wiring is a verified workload no-op. Record both commits and the
source/live comparison in its no-op evidence. Keep it in the frozen roster and
final report, remove it from the workload mutation sequence and do not restart
it.

## Apply the released database phase once

After every frozen member passes preflight and before choosing or changing a
canary, follow [the released database phase](database.md) once with the frozen
roster and resolved release tuple. The exact Fleet instruction satisfies the
released migration-tooling and pending-migration approval boundary; do not ask
again.

Record either the verified database no-op or the exact applied migration range,
journal, checksums, Fleet-owner identity and released security-check result. On
failure, preserve any committed migration evidence and stop before the first
Mate replacement. Never continue into the workload sequence with an incomplete
or unverifiable release journal.

After success or no-op, re-authenticate First Mate and recheck the complete
frozen roster's membership, active work, checkout, declarative/live baseline,
PVC and native sessions. If the shared atomic boundary changed, stop instead of
re-preflighting only the intended canary or silently changing the roster.

## Choose and publish the serial order

If no member needs mutation, keep the frozen roster and proceed to the
consolidated report below without restarting any member. The database result
still belongs in that report.

When any frozen Second Mate still needs mutation, choose one healthy idle
Second Mate that is both in the frozen roster and still needs mutation, at a
safe turn boundary, as canary. The canary must never be First Mate, a verified
no-op, a post-snapshot Mate, or any non-Second-Mate. If none is safe, wait or
ask the Captain rather than interrupting work. Freeze the remaining order:

1. the Second-Mate canary;
2. every remaining Second Mate needing mutation, one at a time; and
3. First Mate last when it needs mutation.

Present the exact handles, no-op members, deferred members and order before the
first mutation. This is a visibility boundary, not another approval request.
Never update members in parallel.

## Apply one atomic operation at a time

For the current named target, apply only the one-Mate procedure with the
already resolved release tuple and the recorded run-once database result.
Supply only that member of the frozen Captain-authorized roster as enclosing
authority. The atomic procedure must not enumerate, sequence or advance the
roster or invoke the database phase again.

Do not continue until the current target reaches its final verification
boundary. Record its exact checkout, release index and observed platform
digest, declarative/live result, readiness, PVC, native session and
preserved-wiring evidence in First Mate's durable native Pi session. Operate
managed Second Mates through native interfaces; do not ask a human to tag them,
duplicate the instruction into another chat or create parallel coordination
state.

On the first failure, stop. Preserve successful members as verified and leave
untouched members unchanged. Do not continue for consistency, automatically
roll back successful members or authorize a second replacement Pod. Follow the
one-Mate recovery boundary for the failed member and report any separately
required authority.

## Update First Mate last and report

When First Mate needs mutation, first verify that every preceding result is
recorded and the frozen-roster boundary remains consistent, then apply its
one-Mate operation last. If First Mate is a verified no-op, keep the current
session and continue through the same report boundary.

After that atomic-operation or no-op branch, the current or resumed
First-Mate native Pi session must verify the branch result, load the frozen
roster and recorded member results, and reconcile each member's current
Kubernetes, Git, PVC and native-session evidence. Report one consolidated
result containing the exact release, run-once database result, every verified
workload update and no-op, every deferred member, and the first failure or
unverified boundary.

Only after this report may First Mate return to ordinary supervision and
re-arm its normal waits. The native Pi session is the rollout record; create no
database table, retained state file, CLI, script, service, controller or other
shadow rollout state.
