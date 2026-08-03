# Provider-access plane operations

This runbook owns AgentOS provider-access install, upgrade, rollback and
recovery. It applies independently to the `github` and `openai` credential
domains. Ordinary Internet traffic remains direct throughout; never add a
global proxy, default-deny egress policy, or provider credential to a Mate as a
recovery shortcut.

## Safety contract

One operation is acknowledged only when
`compileProviderAccessRolloutVerdict` returns `status: verified` and
`acknowledged: true`. The closed Effect input joins:

- the exact Ready release digest for AgentGateway, authorizer and the selected
  provider adapter;
- a completed access-control journal operation at the desired immutable
  profile and ceiling revisions;
- the exact desired credential revision in `credential_ready` state; and
- the exact desired budget revision with enforcement active.

Rollback and restore targets must already be in the bounded verified-release
set. A `pending` or `rollback_required` verdict is not success. The contract
rejects unknown fields, so credentials, response bodies and arbitrary metadata
cannot enter an operation record.

## Read-only preflight

1. Record the clean Git revision and render every owned Kustomize tree. Review
   `kubectl diff --server-side`; never apply directly from a mutable checkout.
2. Inspect workload revision and readiness without reading Secret data:

   ```sh
   kubectl get deployment -n agentos \
     agentgateway-openai agentgateway-github agentos-egress-authz github-broker
   kubectl get statefulset -n agentos ai-gateway
   kubectl get pods -n agentos -o wide
   kubectl get secret -n agentos agentos-github-app \
     -o jsonpath='{.metadata.uid}{" "}{.metadata.resourceVersion}{"\n"}'
   ```

3. Query only bounded journal state. Every access-control operation must be
   `completed` before its profile, binding or ceiling is treated as applied;
   pending or failed operations remain fail closed. Verify the active budget
   override and reservation state through the released Functions, never direct
   table mutation.
4. Prove `/readyz` for the authorizer, selected AgentGateway and selected
   adapter. GitHub readiness must validate the exact App installation and
   authenticated settlement path. OpenAI readiness must validate the selected
   account or explicit API-key fallback and authenticated settlement path.
5. Confirm a selected Mate still has its reviewed direct provider login if the
   singleton AI Gateway requires a controlled restart.

## Install and upgrade

1. Verify a recent restorable AgentOS database backup and OpenFGA backup before
   applying migrations or changing model/runtime versions.
2. Apply database migrations first. Re-run the narrow egress-authorizer grant
   configurator, then prove semantic readiness; a migration is not acknowledged
   merely because the Job or SQL client exited successfully.
3. Upgrade OpenFGA using its version-named migration and bootstrap gates in
   `services/openfga/README.md`. Keep the previous immutable model ID.
4. Apply `agentos-egress-authz`; wait for both Ready replicas. Then update one
   provider domain at a time: adapter first, then its credentialless
   AgentGateway PEP. All Deployments retain three revisions and use
   `maxUnavailable: 0`.
5. A credential change is guarded by the current Secret `resourceVersion`.
   Replace only the selected provider Secret, observe the new revision as
   usable, and roll only that adapter. At the 60-second stale boundary the old
   revision becomes `credential_unavailable`; never acknowledge a mismatch.
6. `ai-gateway` is deliberately a retained-state singleton with
   `updateStrategy: OnDelete`. Verify its PVC backup and direct-provider
   recovery path, apply the reviewed StatefulSet, then explicitly delete only
   `pod/ai-gateway-0`. Wait for semantic readiness before changing the OpenAI
   PEP. The retained PVC is never deleted during upgrade or rollback.
7. Build the rollout verdict from observed state. Complete the operation only
   for `verified/ready`; preserve `pending` for convergence and enter rollback
   for an explicit failed authority.

## Rollback

For the authorizer, GitHub broker and AgentGateway Deployments, restore the
previous reviewed manifests or use native retained revision history, then wait:

```sh
kubectl rollout undo -n agentos deployment/<exact-name>
kubectl rollout status -n agentos deployment/<exact-name> --timeout=10m
```

For `ai-gateway`, reapply the previous reviewed StatefulSet, verify the retained
PVC, delete only `pod/ai-gateway-0`, and wait for `/readyz`. Never delete the
StatefulSet with cascading storage cleanup and never recreate the credential
vault from terminal output.

A policy rollback is a new First-Mate access-control operation against the
previous immutable version; do not edit a completed journal row or OpenFGA
tuple directly. A credential rollback uses a resource-version-guarded restore
of the previous managed Secret revision and rolls only its adapter. A budget
rollback is a new exact set/revoke operation. Recompile the rollout verdict and
acknowledge only the previously verified release digest.

## Backup and restore

The owned AgentOS CloudNativePG topology has three instances and
standby-preferred online VolumeSnapshot backup. The cluster must supply a CSI
snapshot class. Create a uniquely named `postgresql.cnpg.io/v1` `Backup`
targeting `agentos-postgres`, wait for completion, and record only its name,
UID, completion time and snapshot handles. Do not export generated database
Secrets.

Restore into a new Cluster name and new PVCs; never overwrite the failed
Cluster. Follow the official CloudNativePG 1.29
[backup](https://cloudnative-pg.io/docs/1.29/backup/) and
[recovery](https://cloudnative-pg.io/docs/1.29/recovery/) procedures for the
selected VolumeSnapshot or object-store backend. Before cutover:

1. verify the restored Cluster is Ready and passes data checksums;
2. run the complete AgentOS migration chain against the restored database;
3. prove access-control journal, active profile/binding/ceiling, budget override
   and unsettled reservation invariants;
4. point a non-serving authorizer at the recovery endpoint and pass semantic
   readiness; and
5. cut over the database reference only after a rollback path to the original
   endpoint is recorded.

OpenFGA uses its separate three-instance database and backup. Restore it to a
new Cluster, run the pinned model conformance, verify the canonical tuple with
`HIGHER_CONSISTENCY`, then publish the previously verified store/model IDs.

## Adapter compromise

1. Set an `incident_response` effective-zero override for the exact affected
   binding, profile/capability or canonical route. Confirm unrelated subjects
   and the other provider domain remain allowed.
2. Scale down only the compromised adapter after the kill switch is observed.
   Its AgentGateway route must fail closed; ordinary Internet remains direct.
3. Revoke the upstream GitHub App key/installation or OpenAI account material at
   the provider. Replace the selected managed Secret with resource-version
   preconditions. Do not reuse a token found in a Pod or log.
4. Roll the adapter, pass credential and settlement readiness, run one scoped
   provider canary, and inspect bounded telemetry for zero unexpected releases.
5. Remove the kill switch only through an audited `break_glass` revoke after
   the new revision is verified. Recompile the rollout verdict.

## Direct-provider break glass

Direct provider login is an explicit per-Mate recovery mode, not a transparent
fallback and not an authorization bypass. Keep the provider-access route
failed closed, select only the approved Mate, use that Mate's native credential
store, record the incident and expiry, and preserve its existing Captain
ceiling. Never copy an adapter root credential into the Mate namespace. Remove
the direct override after the access plane is verified and test both governed
and ordinary Internet paths again.

## Disposable exercise

`packages/agentos/src/access/tests/disposable-kubernetes.effect.test.ts`
creates a uniquely named namespace in an approved local Kind cluster. In
addition to TokenReview, revocation, hot reload and ordinary Internet, it now:

- deploys two Ready provider probes with `maxUnavailable: 0`;
- applies an intentionally unready revision and proves it never becomes a
  serving endpoint while both previous replicas remain available;
- performs native `kubectl rollout undo` and verifies the previous revision;
- completes a later good upgrade; and
- proves the unrelated workload can reach the Service during rollback.

The Effect finalizer deletes the namespace on success, failure or interruption.
The hard-gate artifact contains only bounded booleans and timings.
