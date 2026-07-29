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
   - changing only the verified stable release metadata: the StatefulSet and
     Pod-template `app.kubernetes.io/version` labels to the requested version;
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
- an immutable multi-platform AgentOS image index digest published by that
  release, with its platform manifest members resolved through native registry
  inspection;
  and
- the appropriate fixed-name First-Mate release asset when First Mate is the
  target, with its version and every AgentOS image matching the release.

Never infer a digest from a mutable tag or release prose. Keep an exact-commit
dogfood rollout separate: load `$agentos-development`,
`$agentos-image-builds` and `$agentos-registry` for that workflow instead.

The canonical release identity is the tuple of the requested semantic version,
the exact commit resolved by its `v<version>` tag, the release image digest,
`app.kubernetes.io/version` on the StatefulSet and Pod template, and
`org.opencontainers.image.version` in each AgentOS image. Do not invent or
trust a source-revision annotation; the image-seed Git HEAD is the canonical
runtime source-revision check.

## Freeze the preflight boundary

Resolve the current execution boundary and exact target context, namespace,
StatefulSet, Pod, AgentOS containers and Mate identity. Record in the current
durable native harness session:

- persistent checkout commit, branch or detached state, cleanliness and target
  tag;
- image-seed commit;
- StatefulSet generation, its `app.kubernetes.io/version` labels, every
  AgentOS init and runtime image, and current ControllerRevision;
- effective StatefulSet update strategy; require `RollingUpdate` with no
  non-zero partition, and stop before mutation for `OnDelete` or any other
  unsupported strategy;
- effective replica count and target Pod; require exactly one desired replica
  and exactly one healthy, non-terminating StatefulSet-owned target Pod, and
  stop before mutation for a scaled, extra, missing or ambiguous Pod;
- effective image pull policy for every target AgentOS init and runtime
  container; require `Always` or `IfNotPresent`, and verify that the target
  runtime either already has the exact release digest or can pull it through
  the approved native registry path. Stop before mutation for `Never`, any
  other policy, or unverified pull access. Preserve this policy in the patch;
- observed Pod image IDs, readiness and restart counts;
- home PVC name, UID and bound volume;
- Herdr session, Mate handle, pane and native harness session reference; and
- redacted, non-secret installation wiring needed to preserve the Pod
  template: field names, labels, annotations, commands, arguments, working
  directories, probes, resources, volume names and mount paths, read-only
  flags, ServiceAccount, security settings, and environment names and source
  types. For Secret-backed fields, record only the Secret name/key and
  reference or mount path; replace literal values with `<redacted>` and never
  record Secret data, tokens, passwords or connection URI contents.

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
- the StatefulSet and Pod-template `app.kubernetes.io/version` labels to the
  requested version.

Preserve PVC templates, mounts, environment, credentials, ServiceAccount,
RBAC, database wiring, probes, resources and unrelated annotations. Any other
diff requires separate authority or a smaller patch. Image pull policy is not
an allowed patch field; changing it requires separate authority.

## Activate one Mate once

1. Switch the clean persistent checkout to the verified release tag without
   deleting the previous branch.
2. Apply the reviewed patch once to the one named Mate.
3. Wait for that one StatefulSet rollout within a bounded deadline.

The expected single Pod replacement is the StatefulSet's `RollingUpdate`; do
not manually delete the Pod, invoke another restart, update another Mate,
create a second harness writer, copy the checkout into the image seed, or
treat temporary rollout unavailability as a reason to broaden the operation.

## Finish verification before supervision

For a managed-Mate update, First Mate remains responsible for the target
verification before reporting or continuing the rollout elsewhere. For a
self-update, the direct supervisor is the recovery owner if the replacement
cannot start Herdr or Pi: the Captain for First Mate, or First Mate for Second
Mate. The initiating worker must not claim recovery or re-arm supervision when
it cannot resume. The recovery owner uses native Kubernetes, Git and Herdr to
inspect the named Mate and the preserved evidence, and asks for separate
authority before any rollback that would require another Pod replacement.

Verify:

- the persistent checkout and image-seed commits equal the release commit;
- every desired AgentOS image reference equals the release multi-platform image
  index digest;
- every observed AgentOS image ID resolves to a platform manifest digest listed
  by that release index; report the index digest together with each observed
  platform and member digest;
- the StatefulSet and Pod-template `app.kubernetes.io/version` labels equal
  the requested version;
- every AgentOS image reports `org.opencontainers.image.version` equal to the
  requested version, and the image-seed Git HEAD equals the exact release-tag
  commit;
- the StatefulSet's current generation is observed and the replacement Pod is
  Ready;
- exactly one StatefulSet-owned target Pod remains for the one replica, with
  the prior Pod no longer active;
- the replacement Pod has no unexpected container restarts;
- the original home PVC UID and native harness session reference remain;
- all recorded installation-specific Pod-template wiring remains.

Report the exact version, commit, release index digest, platform manifest
digests, readiness, PVC and session evidence, plus every deliberately deferred
database or Fleet update. Only after that report may the Mate reconcile and
re-arm normal supervision.

## Roll back visibly

If failure occurs before Pod replacement, restore whichever of checkout or
workload state changed and verify the original runtime.

If the replacement Pod fails readiness or session recovery, restore the
preserved prior checkout reference and immutable images for the same Mate only
under the recovery owner's authority. Preserve its PVC and failed-Pod
evidence, then verify the prior desired and observed state.

Report the first unverified boundary. Do not add credentials, change RBAC,
apply a migration, update another Mate, create a replacement Agent or perform
an unapproved second restart to hide the failure. If the recovery owner cannot
restore the prior state, leave the evidence intact and report the exact live
state to the Captain.
