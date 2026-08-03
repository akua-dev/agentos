# Provider-access operations and recovery plan

**Issue:** #96
**Base:** `67dedc272fbfb5b34ac97547c6a654a45ecd497b`
**Constraint:** AgentOS-owned TypeScript remains Effect-native.

## Outcome

Make provider-access install, upgrade, rollback and recovery acknowledgement a
closed, fail-closed decision over every authority that can drift. Exercise the
Kubernetes rollout and rollback path in a disposable Fleet and publish one
operator runbook that does not expose credentials or couple ordinary Internet
access to the governed provider path.

## Design

- Add a Schema-decoded Effect verdict for one provider domain. It acknowledges
  only exact Ready revisions for AgentGateway, authorizer and provider adapter;
  completed policy/profile/ceiling state; an exact usable credential revision;
  and an enforced budget revision.
- Require rollback and restore targets to appear in the bounded set of
  previously verified release digests. A failed authority requests rollback;
  a merely unapplied authority remains pending. Neither is acknowledged.
- Extend the disposable Kubernetes access proof with a two-replica Deployment
  using `maxUnavailable: 0`, an intentionally unready revision, native rollback
  to the previously Ready ReplicaSet, and a later successful upgrade. Keep the
  unrelated identity and ordinary-Internet probe live throughout.
- Add an operational runbook for install, upgrade, rollback, AgentOS and
  OpenFGA backup/restore, stale model recovery, provider-adapter compromise,
  surgical kill switches and explicit direct-provider break glass.
- Harden the remaining provider-adapter Deployment with bounded revision
  history and topology spread so the documented rollback has retained native
  history and failure-domain distribution.

## Verification

1. Add failing Effect tests for exact acknowledgement, every authority drift,
   rollback provenance and privacy.
2. Add failing manifest assertions for retained revision history and topology.
3. Implement the Effect contract and manifest changes.
4. Extend the disposable proof and its hard-gate artifact with rollout facts.
5. Update the provider-access child gate and runbook documentation.
6. Run focused tests, Kustomize renders, the disposable Kind proof, Effect
   policy, the complete repository check and normal GitHub CI.
