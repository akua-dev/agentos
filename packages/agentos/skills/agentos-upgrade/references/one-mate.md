# Atomic stable upgrade for one persistent Mate

This procedure applies only to the one named target accepted by
`$agentos-upgrade`. For a Fleet rollout, the enclosing Fleet procedure supplies
only its current frozen-roster member and already resolved release tuple.
Never enumerate, reorder or advance the Fleet here.

## Contents

- [Verify the release](#verify-the-release)
- [Freeze the preflight boundary](#freeze-the-preflight-boundary)
- [Reconcile the released database](#reconcile-the-released-database)
- [Preview the reversible change](#preview-the-reversible-change)
- [Activate one Mate once](#activate-one-mate-once)
- [Diagnose a failed rollout](#diagnose-a-failed-rollout)
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
Release publication, image metadata and a successful pull prove provenance and
availability; they do not prove that this Mate's role-specific init and runtime
paths can start.

Before database inspection or mutation, materialize the verified tag commit as
a clean, read-only native Git source root separate from the persistent active
checkout. Record that root, its exact tag and commit, and keep the same source
root through database preparation and preview. The selected release's database
assets and pinned tooling must come from this root; never let
`database:prepare` fall back to the active checkout.

## Freeze the preflight boundary

Resolve the current execution boundary and exact target context, namespace,
StatefulSet, Pod, AgentOS containers and Mate identity. Record secret-safe
evidence in the current durable native Pi session:

- persistent checkout commit, branch or detached state, cleanliness and target
  tag;
- read-only target-release source root, exact tag and commit;
- image-seed commit;
- any installation-owned Kustomize or resource source for the target, its exact
  paths, a secret-safe render, and the rendered release identity and preserved
  wiring compared structurally with the live StatefulSet;
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
pull access, an unverifiable release, unexplained checkout or image mismatch,
an unavailable or changed target-release source root, or a declarative/live
difference outside the release-field reconciliation below. When an
installation-owned declarative source exists, it is canonical for the fields it
declares. A difference limited to the release fields permitted in Preview, or
to preview-only source metadata, is a recorded, reconcilable drift: preserve the
source and carry that comparison into Preview. A difference in any other
declared wiring, an unrenderable source, or ambiguous ownership remains a hard
stop. Never overwrite the source to match live state or apply it before the
released database result.

## Reconcile the released database

For a standalone named-Mate upgrade, after the complete target preflight passes
and before changing Git, a declarative source or Kubernetes, follow
[the released database phase](database.md). The database reference records a
verified no-op or applies the selected release's pending migrations once under
the same upgrade authority. For a Fleet rollout, consume the enclosing Fleet
procedure's recorded database result and never invoke that phase per member.

If a Second-Mate self-update requires First Mate to execute the Fleet-owner
database phase, wait for First Mate's exact result instead of requesting a new
Captain approval or continuing locally. After the database result, recheck the
named target's identity, checkout, declarative/live baseline,
target-release source root, active work, PVC and native session. Stop if any
earlier preflight fact no longer holds.

## Preview the reversible change

Keep the previous checkout branch or exact commit reachable. Record the prior
immutable images, version and source metadata, ControllerRevision, PVC UID and
native Pi session reference before changing Git or Kubernetes. When an
installation-owned declarative source exists, also preserve its exact prior
release fields and secret-safe rendered comparison. The native session is the
recovery record; create no upgrade-state file, shadow manifest or database row.

When an installation-owned declarative source exists, treat it as canonical and
change only its release fields through the native Kustomize or resource path.
This render-and-apply path is the supported reconciliation for the recorded
release-field drift; never copy live values back into the source. When none
exists, build the smallest patch from the observed live workload and record
that boundary instead of inventing a persistent source. Preview the resulting
resource against the live API and inspect the complete structured diff. Permit
only:

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
2. Apply the reviewed rendered source or live patch once to the named Mate.
3. Wait for that StatefulSet rollout within a bounded deadline. The replacement
   runtime invalidates its process-bound coordination marker by design; its
   startup recovery turn must re-arm and attest the targeted listener, catch up
   from current bearings, and confirm catch-up before the Pod becomes Ready.
   A live Pod reporting only those readiness reasons is recovering, not evidence
   for another restart.

The expected single Pod replacement belongs to the StatefulSet's
`RollingUpdate`. Do not manually delete the Pod, invoke another restart, update
another Mate, create a second harness writer, copy the checkout into the image
seed, or broaden the operation because the rollout is temporarily unavailable.

## Diagnose a failed rollout

If the bounded rollout wait fails or the replacement is not Ready, preserve
secret-safe evidence before recovery:

- StatefulSet observed generation, current and update ControllerRevisions;
- target Pod ownership, phase, scheduling state and bounded events;
- every init and runtime container's state, reason, exit code, restart count,
  desired image and observed image ID;
- bounded current and previous logs for the failed container without Secret
  values;
- the retained home PVC identity; and
- Herdr and native Pi session identity when the runtime reached those layers.

Classify the first failed boundary as scheduling, image retrieval, init,
runtime, readiness or native-session recovery. Do not hide it with a live
dependency workaround, `NODE_PATH` change, PVC patch, credential change,
unreviewed environment mutation, manual Pod deletion or update to another Mate.

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
- any installation-owned declarative source renders the same selected release
  identity and preserved wiring now observed on the live StatefulSet;
- the current StatefulSet generation is observed and the replacement Pod is
  Ready;
- exactly one StatefulSet-owned target Pod remains and the prior Pod is no
  longer active;
- the replacement has no unexpected container restarts;
- the original home PVC UID and native Pi session reference remain; and
- all recorded installation-specific Pod-template wiring remains.

Report the exact version, commit, release index and platform digests, readiness,
database result, declarative/live source result, PVC and session evidence, and
every deliberately deferred Fleet update. Inside a Fleet rollout, return that
result without selecting another member. Otherwise, reconcile and re-arm
ordinary supervision only after the report.

## Roll back visibly

If failure occurs before Pod replacement, restore whichever of checkout,
installation-owned declarative source or workload state changed and verify the
original source/live agreement and runtime.

If the replacement fails readiness or session recovery, preserve the failed-Pod
evidence from the diagnostic boundary. Restore the prior checkout reference,
installation-owned declarative release fields and immutable images for the same
Mate only under the recovery owner's authority. A rollback requiring another
Pod replacement needs separate authority; the original upgrade instruction
does not grant it. After an authorized restore, verify the prior declarative
source renders the restored live release and wiring, the prior checkout and
image-seed commits, every desired image reference and observed image ID against
the prior release's platform members, the prior version and source metadata,
StatefulSet generation and readiness, the original home PVC UID and native Pi
session reference, and all recorded installation-specific Pod-template wiring
before reporting recovery. If any restored-runtime check is unverified, report
that boundary and the exact live state instead of declaring rollback complete.

Report the first unverified boundary. Do not add credentials, change RBAC,
replay a migration, update another Mate, create a replacement Agent or perform
an unapproved second restart to hide failure. If the recovery owner cannot
restore prior state, leave the evidence intact and report the exact live state
to the Captain.
