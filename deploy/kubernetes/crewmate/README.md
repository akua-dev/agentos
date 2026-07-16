# Crewmate runtime

The first released Crewmate primitive starts a trusted Codex worker inside an
existing First- or Second-Mate pod. It acquires or recovers a durably leased
detached Git worktree through [Treehouse](https://github.com/kunchenguid/treehouse),
loads the released Crewmate role contract and starts one named Agent in the
pod's existing Herdr session.

This is an explicit shared-security-boundary mode. The worker can access the
Mate's home, provider credentials, database credential and Kubernetes service
account. Use it only after the Captain approves that sharing; the launcher
refuses to run unless `--allow-shared-home true` is present. The normal target
topology is one pod and durable home per Agent. A selected `image` therefore
belongs to the later dedicated-pod launcher and is never silently ignored here.

Before launch, the owning Mate creates the Crewmate identity, Task and active
Assignment, provisions its database access, writes a complete brief and resolves
the concrete harness, model and effort. The launcher makes no routing decision:

```console
mise run crewmate:spawn -- \
  --allow-shared-home true \
  --handle fix-api \
  --agent-id 30000000-0000-4000-8000-000000000003 \
  --task-id 40000000-0000-4000-8000-000000000004 \
  --assignment-id 50000000-0000-4000-8000-000000000005 \
  --kind ship \
  --project /home/agent/projects/api \
  --brief /home/agent/briefs/fix-api.md \
  --database-url postgresql://runtime_fix_api@postgres.example:5432/agentos?sslmode=require \
  --pgpass-file /home/agent/.local/state/agentos/credentials/fix-api.pgpass \
  --harness codex \
  --model gpt-5.5 \
  --effort high
```

Codex is the only reviewed Crewmate adapter in this slice. An unknown harness
fails before Git, Mise or Herdr is touched. The worktree defaults to
Treehouse's clean detached default-branch lease and the Herdr session defaults
to `HERDR_SESSION`. A unique lease holder derived from the Agent UUID makes a
failed launch recoverable without acquiring another worktree.

The Crewmate receives its own password-free PostgreSQL URL and private pgpass
file rather than inheriting the Mate's database identity. Codex runs inside
Mise's [lightweight process sandbox](https://mise.jdx.dev/sandboxing.html), with
writes limited to its Treehouse worktree, shared Git metadata, Codex state and
Mise tool data. Network remains available for coding work. This reduces
accidental access but is not a pod or kernel security boundary, so the explicit
shared-home approval remains required. The pinned Mise release still marks this
feature experimental, so the launcher enables it only in the Crewmate process
instead of changing the Mate's global Mise settings.

After a successful start, the owning Mate records the returned worktree and
Herdr locator on the Agent row and moves its lifecycle out of `provisioning`.
Cleanup remains guarded by the Task/Assignment delivery checks and returns the
lease through Treehouse rather than deleting Git metadata directly.
