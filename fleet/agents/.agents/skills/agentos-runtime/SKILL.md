---
name: agentos-runtime
description: Inspect, create, and operate AgentOS runtime pods, Kustomize overlays, Herdr sessions, Mise toolchains, agent worktrees, terminals, PVCs, Kubernetes health, attach paths and runtime recovery. Use for normal First- or Second-Mate Kubernetes operations, child-Agent workload creation, tool resolution, stuck-agent debugging, remote terminal access, pod or session recovery, and readiness diagnosis.
---

# Operate AgentOS runtime

Use Kubernetes for workload truth and the pod-local Herdr server for terminal truth.

## Inspect before action

1. Resolve an explicit Kubernetes context, namespace, workload and agent identity.
2. Inspect pod phase, readiness, ownership, PVC bindings and immutable release identity.
3. Query the target Herdr server for its agents, panes, semantic status and native harness session reference.
4. Explain the fault boundary before changing anything.

## Attach and debug

- From outside the cluster, a human or seed agent uses native `kubectl` with an explicit context to enter the target pod and invoke Herdr. A running Mate uses the same native interface against its in-cluster credentials, for example `kubectl --namespace <namespace> exec -it pod/<pod> --container <container> -- herdr --session <session>`.
- Attach to the real agent terminal for interactive diagnosis.
- Use Herdr read, status, send and wait primitives for bounded inspection; do not scrape or persist terminal output automatically.
- Treat a live terminal send as an immediate hint only. Keep durable inter-agent communication in PostgreSQL.
- Ask before interrupting, restarting, closing, taking over, or rearranging an existing user session.

## Runtime topology

- Run one pinned Herdr server per runtime pod.
- Keep First and Second Mates on Pi. Permit released worker harnesses such as Pi or Codex.
- Keep one pod, ServiceAccount, durable home PVC, database principal and
  pod-local Herdr server per Agent.
- Use `../secondmate/kubernetes/base` from First Mate and
  `../crewmate/kubernetes/base` from either Mate. Never apply a generic base
  directly: it contains visible placeholder identity and local-development
  image values.
- Use `AGENTOS_AGENT_NAME`, `AGENTOS_AGENT_CWD`, `HERDR_SESSION` and the
  role-scoped Mise tasks to run the common Mate runtime. Preserve one exact
  named Herdr Agent and fail closed on duplicates.
- Allow ordinary processes beside agents in Herdr panes.
- Arrange optional fleet workspaces with Kubernetes-exec panes into remote
  pod-local Herdr sessions when requested. The remote sessions remain
  authoritative.

## Create a child workload

1. Load `$agentos-delegation`, `$agentos-database` and `$agentos-harnesses`.
   Provision the Agent, Task, Assignment, database login and approved pgpass
   Secret before Kubernetes mutation.
2. Create `$HOME/.local/state/agentos/workloads/<handle>/kustomization.yaml`.
   Reference the released child base and patch every placeholder: resource
   names, Agent labels and UUID, Herdr session, database URL and Secret, Task
   and Assignment UUIDs where applicable, storage, selected image and image
   pull policy. Published images require an immutable digest.
3. Render a review artifact with native kubectl:

   ```console
   kubectl kustomize --load-restrictor LoadRestrictionsNone \
     "$HOME/.local/state/agentos/workloads/<handle>" \
     --output "$HOME/.local/state/agentos/workloads/<handle>/rendered.yaml"
   ```

4. Inspect the complete rendered resources. Require exactly one dedicated
   ServiceAccount, headless Service and retained one-replica StatefulSet; reject
   placeholder values, unexpected RBAC, public endpoints, mutable remote images
   and ownership conflicts.
5. Ask for any installation, cost or RBAC approval not already recorded. Then
   validate against the API server and inspect the diff:

   ```console
   kubectl --namespace <namespace> apply --server-side --dry-run=server \
     --filename "$HOME/.local/state/agentos/workloads/<handle>/rendered.yaml"
   kubectl --namespace <namespace> diff --server-side \
     --filename "$HOME/.local/state/agentos/workloads/<handle>/rendered.yaml"
   ```

   `kubectl diff` exit status `1` means a diff exists; other non-zero statuses
   are failures.
6. Apply synchronously and retain the native result:

   ```console
   kubectl --namespace <namespace> apply --server-side \
     --filename "$HOME/.local/state/agentos/workloads/<handle>/rendered.yaml"
   kubectl --namespace <namespace> rollout status statefulset/<name>
   ```

7. Verify observed image IDs, ServiceAccount, Pod, PVC, Secret mount, Agent
   environment and Herdr status. For a Crewmate, create or recover the project
   and Treehouse lease inside that pod. Copy the fully rendered brief with
   native kubectl and verify its digest inside the pod:

   ```console
   kubectl --namespace <namespace> cp \
     "$HOME/.local/state/agentos/workloads/<handle>/brief.md" \
     "<pod>:/home/agent/brief.md" --container crewmate
   kubectl --namespace <namespace> exec pod/<pod> --container crewmate -- \
     sha256sum /home/agent/brief.md
   ```

   The destination must match the workload's `AGENTOS_BRIEF_PATH`. Then use
   `$agentos-harnesses` to invoke
   `herdr agent start ... -- <native-harness-argv> <brief>` through
   `kubectl exec`.
8. Record verified Kubernetes and Herdr locators in Fleet state. On partial
   failure, preserve the identity, PVC and rendered evidence for reconciliation;
   never create a replacement Agent to hide the error.

## Resolve tools with Mise

1. Inspect effective configuration with `mise config ls`, requested versions with `mise ls --current`, and executable ownership with `mise which <tool>` before changing tools.
2. At image build time, install the released `fleet/mise.toml` and
   `fleet/mise.lock` as `/etc/mise/config.toml` and `/etc/mise/mise.lock`, and
   bake their pinned Bun into the image. Seed the same reviewed Fleet pair as
   the agent's global `~/.config/mise/config.toml` and `mise.lock` on its PVC.
   Install the remaining startup-critical tools before adding agent-owned
   entries under `~/.config/mise/conf.d/`; install other released tools only
   when the task needs them.
3. Prepend Mise shims to `PATH` for interactive and non-interactive processes so released tools win over unmanaged globals. Verify ordinary tool names work without a `mise exec` prefix.
4. Let configuration in the current repository or worktree add tools and override conflicting baseline versions. Do not copy AgentOS's project config into another repository.
5. Inspect repository-owned Mise configuration before trust. Ask before trusting executable hooks or environment behavior that is not already approved with the project.
6. Put approved persistent agent additions in that agent's Mise configuration on its PVC. Change a repository-owned tool version only through the repository's normal delivery workflow.
7. Do not fall back to npm-global, Homebrew, apt, or `curl | sh` when a tool is absent. Report the missing reviewed Mise asset or request the appropriate scoped configuration change.

## Health and recovery

- Keep liveness limited to a technically functioning runtime.
- Fail readiness only for explicit, supported degradation classes on required agents; ordinary human-blocked state is not a readiness failure.
- Preserve attach access during provider, quota and rate-limit failures.
- Reuse the owned PVC and native harness session during pod replacement.
- Let the supervising model decide whether to retry, attach, rotate auth, change model, restart a process, or leave the agent stopped.

Use only released Kustomize assets and native tool interfaces. Fail closed on ambiguous ownership or missing runtime assets.
