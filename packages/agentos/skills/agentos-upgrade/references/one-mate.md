# Atomic stable upgrade for one persistent Mate

This procedure applies only to the one named target accepted by
`$agentos-upgrade`. For a Fleet rollout, the enclosing Fleet procedure supplies
only its current frozen-roster member and already resolved release tuple.
Never enumerate, reorder or advance the Fleet here.

## Contents

- [Verify the release](#verify-the-release)
- [Freeze the preflight boundary](#freeze-the-preflight-boundary)
- [Preview the reversible change](#preview-the-reversible-change)
- [Activate one Mate once](#activate-one-mate-once)
- [Finish verification before supervision](#finish-verification-before-supervision)
- [Roll back visibly](#roll-back-visibly)

## Verify the release

Use the official provider, Git and registry origins to require:

- a published, non-draft, non-prerelease semantic-version release;
- a release tag that resolves to one exact commit on the official default
  branch;
- an immutable multi-platform AgentOS image index digest published by that
  release, with its platform manifest members resolved through native registry
  inspection; and
- the appropriate fixed-name First-Mate release asset when First Mate is the
  target, with its version and every AgentOS image matching the release.

Never infer a digest from a mutable tag or release prose. The canonical release
identity is the tuple of:

- requested semantic version;
- exact commit resolved by its `v<version>` tag;
- release image index digest and platform members;
- `app.kubernetes.io/version` on the StatefulSet and Pod template; and
- `org.opencontainers.image.version` in each AgentOS image.

Treat `agentos.akua.dev/source-revision` on the StatefulSet or Pod template as
preview-only dogfood provenance. Do not create or update it for a stable
release. Use the image-seed Git HEAD as the runtime source-revision check.

## Freeze the preflight boundary

Resolve the current execution boundary and exact target context, namespace,
StatefulSet, Pod, AgentOS containers and Mate identity. Record secret-safe
evidence in the current durable native Pi session:

- persistent checkout commit, branch or detached state, cleanliness and target
  tag;
- image-seed commit;
- StatefulSet generation, `app.kubernetes.io/version` labels, every AgentOS
  init and runtime image, current ControllerRevision, and any
  `agentos.akua.dev/source-revision` annotation on the StatefulSet or Pod
  template;
- effective StatefulSet update strategy; require `RollingUpdate` with no
  non-zero partition and stop for `OnDelete` or another unsupported strategy;
- effective replica count and target Pod; require exactly one desired replica
  and one healthy, non-terminating StatefulSet-owned target Pod;
- effective image pull policy for every target AgentOS init and runtime
  container; require `Always` or `IfNotPresent`, verify that the runtime already
  has the exact release digest or can pull it through the approved native
  registry path, and preserve the policy;
- observed Pod image IDs, readiness and restart counts;
- home PVC name, UID and bound volume;
- Herdr session, Mate handle, pane and native Pi session reference; and
- redacted installation wiring needed to preserve the Pod template: field
  names, labels, annotations, commands, arguments, working directories, probes,
  resources, volume names and mount paths, read-only flags, ServiceAccount,
  security settings, and environment names and source types.

For Secret-backed fields, record only the Secret name/key and reference or
mount path. Replace literal values with `<redacted>` and never record Secret
data, tokens, passwords or connection URI contents.

Stop before mutation on insufficient authority, a dirty checkout, an ambiguous
Mate or session, a scaled, extra or missing target Pod, an unbound PVC, an
unhealthy current runtime, an unsupported update or pull policy, unverified
pull access, an unverifiable release, or an unexplained checkout, source or
image mismatch. Never reset, clean or overwrite the checkout to make preflight
pass.

Apply no database migration and start no partial-migration investigation.
Preserve the database Secret and connection wiring. If the target runtime
cannot use the installed schema, roll back the runtime under the recovery
boundary and report the incompatibility.

## Preview the reversible change

Keep the previous checkout branch or exact commit reachable. Record the prior
immutable images, version and source metadata, ControllerRevision, PVC UID and
native Pi session reference before changing Git or Kubernetes. The native
session is the recovery record; create no upgrade-state file or database row.

Build the smallest patch from the observed live workload instead of replacing
its installation-specific manifest. Preview it against the live API and inspect
the structured diff. Permit only:

- every AgentOS init and runtime container image changing to the same verified
  release index digest;
- StatefulSet and Pod-template `app.kubernetes.io/version` labels changing to
  the requested version; and
- removal of `agentos.akua.dev/source-revision` from the StatefulSet and Pod
  template when present.

Preserve PVC templates, mounts, environment, credentials, ServiceAccount,
RBAC, database wiring, probes, resources, pull policies and unrelated
annotations. Any other diff requires separate authority or a smaller patch.

## Activate one Mate once

1. Switch the clean persistent checkout to the verified release tag without
   deleting the previous branch.
2. Apply the reviewed patch once to the named Mate.
3. Wait for that StatefulSet rollout within a bounded deadline.

The expected single Pod replacement belongs to the StatefulSet's
`RollingUpdate`. Do not manually delete the Pod, invoke another restart, update
another Mate, create a second harness writer, copy the checkout into the image
seed, or broaden the operation because the rollout is temporarily unavailable.

## Finish verification before supervision

For a managed-Mate update, First Mate remains responsible for final target
verification before reporting or selecting another member. For a self-update,
the direct supervisor becomes recovery owner if the replacement cannot start
Herdr or Pi: the Captain for First Mate, or First Mate for Second Mate. A worker
that cannot resume must not claim recovery or re-arm supervision.

Verify:

- persistent checkout and image-seed commits equal the release commit;
- every desired AgentOS image reference equals the release index digest;
- every observed AgentOS image ID resolves to a platform manifest listed by
  that index, reporting both the index and observed member digest;
- StatefulSet and Pod-template `app.kubernetes.io/version` labels equal the
  requested version;
- every AgentOS image reports `org.opencontainers.image.version` equal to the
  requested version;
- `agentos.akua.dev/source-revision` is absent from StatefulSet and Pod
  template;
- the current StatefulSet generation is observed and the replacement Pod is
  Ready;
- exactly one StatefulSet-owned target Pod remains and the prior Pod is no
  longer active;
- the replacement has no unexpected container restarts;
- the original home PVC UID and native Pi session reference remain; and
- all recorded installation-specific Pod-template wiring remains.

Report the exact version, commit, release index and platform digests, readiness,
PVC and session evidence, and every deliberately deferred database or Fleet
update. Inside a Fleet rollout, return that result without selecting another
member. Otherwise, reconcile and re-arm ordinary supervision only after the
report.

## Roll back visibly

If failure occurs before Pod replacement, restore whichever of checkout or
workload state changed and verify the original runtime.

If the replacement fails readiness or session recovery, preserve the failed-Pod
evidence. Restore the prior checkout reference and immutable images for the same
Mate only under the recovery owner's authority. A rollback requiring another
Pod replacement needs separate authority; the original upgrade instruction
does not grant it. After an authorized restore, verify the prior checkout and
image-seed commits, every desired image reference and observed image ID against
the prior release's platform members, the prior version and source metadata,
StatefulSet generation and readiness, the original home PVC UID and native Pi
session reference, and all recorded installation-specific Pod-template wiring
before reporting recovery. If any restored-runtime check is unverified, report
that boundary and the exact live state instead of declaring rollback complete.

Report the first unverified boundary. Do not add credentials, change RBAC,
apply a migration, update another Mate, create a replacement Agent or perform
an unapproved second restart to hide failure. If the recovery owner cannot
restore prior state, leave the evidence intact and report the exact live state
to the Captain.
