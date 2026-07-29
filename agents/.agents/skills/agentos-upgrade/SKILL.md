---
name: agentos-upgrade
description: Upgrade one persistent AgentOS Mate to an exact published stable release, resume its post-replacement verification, or roll back that failed upgrade while preserving its checkout, PVC, native harness session and installation-specific Kubernetes wiring. Use when the Captain authorizes a stable First- or Second-Mate update or First Mate updates one managed Mate. Do not use for dogfood rollouts, database migrations or Fleet-wide rollout.
---

# Upgrade one persistent Mate

Use native provider, Git, Kubernetes and Herdr interfaces. Pi exposes this Skill
as `/skill:agentos-upgrade`; do not add a harness-specific command or an
AgentOS wrapper.

Load `$agentos-runtime` before inspecting or changing Kubernetes or Herdr.

## Establish exact authority

1. Require one named Mate and one exact stable semantic version.
2. First Mate may update itself or one managed Mate. A Second Mate may update
   only itself, and only with exact Captain authority delivered directly or
   through First Mate consistently with its charter.
3. One exact instruction authorizes only:
   - switching that Mate's clean persistent AgentOS checkout to the verified
     release;
   - updating that one Mate workload to the release's immutable image; and
   - the single Pod replacement required to activate the image.
4. If the Captain says only “update AgentOS,” resolve and present the newest
   stable candidate, then obtain confirmation of the exact version before
   mutation. Skip that confirmation only when exact standing authority already
   defines both selection and the named Mate.

The instruction does not authorize another Mate, Fleet fan-out, a database
migration or repair, topology, credentials, RBAC, source delivery, release
publication, merge, dirty-state removal, or retirement of a PVC, session,
Agent or rollback reference.

## Verify the release

Use the official provider and Git origins to require all of these:

- a published, non-draft, non-prerelease semantic-version release;
- a release tag that resolves to one exact commit on the official default
  branch;
- an immutable multi-platform AgentOS image digest published by that release;
  and
- the appropriate fixed-name First-Mate release asset when First Mate is the
  target, with its version and every AgentOS image matching the release.

Never infer a digest from a mutable tag or release prose. Keep an exact-commit
dogfood rollout separate: load `$agentos-development`,
`$agentos-image-builds` and `$agentos-registry` for that workflow instead.

## Freeze the preflight boundary

Resolve the current execution boundary and exact target context, namespace,
StatefulSet, Pod, AgentOS containers and Mate identity. Record in the current
durable native harness session:

- persistent checkout commit, branch or detached state, cleanliness and target
  tag;
- image-seed commit;
- StatefulSet generation, version and source metadata, every AgentOS init and
  runtime image, and current ControllerRevision;
- observed Pod image IDs, readiness and restart counts;
- home PVC name, UID and bound volume;
- Herdr session, Mate handle, pane and native harness session reference; and
- every installation-specific Pod-template field that the image-only update
  must preserve.

Stop before mutation on insufficient authority, a dirty checkout, an
ambiguous Mate or session, an unbound PVC, an unhealthy current runtime, an
unverifiable release or an unexplained checkout, source or image mismatch.
Never reset, clean or overwrite the checkout to make preflight pass.

This upgrade applies no database migration and starts no partial-migration
investigation. Preserve the database Secret and connection wiring. If the
target runtime cannot use the installed schema, roll back the runtime and
report the exact incompatibility. Load `$agentos-database` only for a
separately authorized migration; never use a partial migration as rollout
recovery.

## Preview the reversible change

Keep the previous checkout branch or exact commit reachable. Record the prior
immutable images, version and source metadata, ControllerRevision, PVC UID and
native harness session reference before changing either Git or Kubernetes.
The native session is the recovery record; do not create shadow upgrade state.

Build the smallest patch from the observed live workload, not by replacing its
installation-specific manifest. Preview it against the live API and inspect
the structured diff. It may change only:

- every AgentOS init and runtime container image to the same verified release
  digest;
- workload and Pod-template stable-version labels;
- exact source-revision annotations; and
- preview-only annotations that are invalid for a stable release.

Preserve PVC templates, mounts, environment, credentials, ServiceAccount,
RBAC, database wiring, probes, resources and unrelated annotations. Any other
diff requires separate authority or a smaller patch.

## Activate one Mate once

1. Switch the clean persistent checkout to the verified release tag without
   deleting the previous branch.
2. Apply the reviewed patch once to the one named Mate.
3. Wait for that one StatefulSet rollout within a bounded deadline.

The expected Pod replacement is part of the authorized operation. Do not
update another Mate, create a second harness writer, copy the checkout into the
image seed, invoke another restart or treat temporary rollout unavailability
as a reason to broaden the operation.

## Finish verification before supervision

The worker that owns the upgrade remains responsible across Pod replacement.
For a self-update, the resumed native harness session must finish this
verification and report before it arms or returns to ordinary supervision. For
a managed-Mate update, First Mate must complete the same target verification
before reporting or continuing the rollout elsewhere.

Verify:

- the persistent checkout and image-seed commits equal the release commit;
- every desired and observed AgentOS image equals the release digest;
- the StatefulSet's current generation is observed and the replacement Pod is
  Ready;
- the replacement Pod has no unexpected container restarts;
- the original home PVC UID and native harness session reference remain;
- all recorded installation-specific Pod-template wiring remains; and
- preview-only release metadata is gone.

Report the exact version, commit, digest, readiness, PVC and session evidence,
plus every deliberately deferred database or Fleet update. Only after that
report may the Mate reconcile and re-arm normal supervision.

## Roll back visibly

If failure occurs before Pod replacement, restore whichever of checkout or
workload state changed and verify the original runtime.

If the replacement Pod fails readiness or session recovery, restore the
preserved prior checkout reference and immutable images for the same Mate.
Preserve its PVC and failed-Pod evidence, then verify the prior desired and
observed state.

Report the first unverified boundary. Do not add credentials, change RBAC,
apply a migration, update another Mate or create a replacement Agent to hide
the failure. If rollback also fails, remain attached and report the exact live
state.
