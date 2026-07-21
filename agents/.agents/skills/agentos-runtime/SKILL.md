---
name: agentos-runtime
description: Inspect, create, and operate AgentOS runtime pods, Kustomize overlays, Herdr sessions, Mise toolchains, agent worktrees, terminals, PVCs, Kubernetes health, attach paths and runtime recovery. Use for normal First- or Second-Mate Kubernetes operations, child-Agent workload creation, tool resolution, stuck-agent debugging, remote terminal access, pod or session recovery, and readiness diagnosis.
---

# Operate AgentOS runtime

Use Kubernetes for workload truth and the pod-local Herdr server for terminal truth.

## Inspect before action

1. Resolve the current execution boundary and the intended target before
   choosing a transport. Use the same independent signals as bootstrap:
   `KUBERNETES_SERVICE_HOST` plus its Service port, the standard mounted
   ServiceAccount CA/token/namespace files without printing the token, and a
   read-only API confirmation when identity matters. The namespace file is
   authoritative for that mount; the hostname is only a weak Pod-name hint,
   and Pod/container environment names exist only when the workload supplies
   them. Distinguish the current cluster, namespace, Pod, container, Agent and
   database identity from the target rather than assuming that a shell with
   `kubectl` is outside Kubernetes.
2. Resolve an explicit target Kubernetes context, namespace, workload and agent identity.
3. Inspect pod phase, readiness, ownership, PVC bindings and immutable release identity.
4. Query the target Herdr server with `herdr agent get <handle> --session
   <session>` for the exact Agent, semantic status, working directory and
   native harness session reference when available. Use `herdr pane
   process-info` to corroborate the live process when diagnosis or recovery
   depends on it; recover a missing native reference only from recorded state
   or the same pane.
5. Explain the fault boundary before changing anything.

When the current runtime and intended target are the same Pod, container,
identity and tool environment, invoke the native command there directly. When
the target differs, or an explicit isolation or identity boundary requires the
target runtime, use native `kubectl exec` with the resolved context, namespace,
Pod and container. Neither path is a global preference: an exec into the
current Pod can still be deliberate, but it should not be an accidental hop
caused by forgetting where the caller already runs.

## Attach and debug

- From outside the cluster, a human or seed agent uses native `kubectl` with an explicit context to enter the target Pod and invoke Herdr. A running Mate invokes its local Herdr CLI directly when that Pod is the resolved target; it uses `kubectl exec` with its in-cluster credentials when the target is another Pod or container.
- Attach to the real agent terminal for interactive diagnosis.
- Use Herdr read, status, send and wait primitives for bounded inspection; do not scrape or persist terminal output automatically.
- After launch, steer, `/reload` or resume, verify that the exact Herdr Agent
  enters `working`, or that the exact Agent produced fresh completion evidence
  before the observation. Do not call a process healthy
  merely because the Herdr server or Pod is ready.
- Treat a live terminal send as an immediate hint only. Use
  `$agentos-supervision`'s provenance marker for a supervisor-origin hint and
  keep durable inter-agent communication in PostgreSQL.
- Ask before interrupting, restarting, closing, taking over, or rearranging an existing user session.
- Attach to the existing named Mate session. Never launch a second independent
  Pi writer for the same home. If Pod, Herdr and native session identity do not
  agree, remain read-only until the owning Mate state is reconciled.

## Submit a Crewmate doorbell

Use this only after the owning Mate has committed a downward Inbox row. The
doorbell is not a second message body and is not the normal delivery path for a
persistent Mate.

1. Query the exact named Herdr Agent and record its pane, session and semantic
   status. If it is working or the composer state is ambiguous, do not type over
   it; wait for a safe boundary or use the reviewed recovery path.
2. Write only the canonical supervisor marker plus
   `Inbox <kind> <uuid> — <subject>; load it from PostgreSQL.` with native
   `herdr agent send <handle> <text> --session <session>`. This command writes
   literal text into the target terminal; it does not submit it.
3. Submit that text with native
   `herdr pane send-keys <pane_id> enter --session <session>`.
4. Verify the exact Agent enters `working` with `herdr agent wait`, or that the
   matching Inbox row acquired `read_at` before the observation. Pane text alone
   is not receipt evidence.
5. If delivery fails before receipt, preserve and retry the same Inbox UUID.
   Never create a duplicate row or include the full body in the terminal.

Run these commands through the target Pod's own Herdr CLI. From outside the
cluster, reach it with native `kubectl` and an explicit context. From a Mate,
invoke Herdr locally when it owns the target Pod, or use its in-cluster
Kubernetes credentials when the target is remote. Do not add an AgentOS
wrapper CLI for this sequence.

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
   and Treehouse lease inside that pod. Copy the PostgreSQL-authoritative
   brief's rendered harness view with
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
8. Record verified Kubernetes and Herdr locators in Fleet state. Treat launch
   as successful only after the native harness is processing the complete brief
   without a trust or routine command-approval dialog. The owning Mate must use
   `$agentos-harnesses` to reconcile a missing unattended launch or reviewed
   repository-trust preflight instead of repeatedly pressing through ordinary
   commands. On partial failure, preserve the identity, PVC and rendered
   evidence for reconciliation; never create a replacement Agent to hide the
   error.

## Resolve tools with Mise

1. Inspect effective configuration with `mise config ls`, requested versions with `mise ls --current`, and executable ownership with `mise which <tool>` before changing tools.
2. At image build time, install the released root `mise.toml` and
   `mise.lock` as `/etc/mise/config.toml` and `/etc/mise/mise.lock`, and
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
- Reconcile a stopped worker against its recorded Assignment and Treehouse
  worktree before resume. Preserve same-task work and refuse a fresh workspace
  while ownership is ambiguous.
- Preserve the Herdr Agent's native session reference before a deliberate exit.
  Prefer the harness's documented graceful command or quit keybinding, then
  resume the same native session with the current reviewed flags. Use Pi
  `/reload` only for reloadable resources, not as a substitute for process,
  environment or authentication recovery.
- Let the supervising model decide whether to retry, attach, rotate auth, change model, restart a process, or leave the agent stopped.

Use only released Kustomize assets and native tool interfaces. Fail closed on ambiguous ownership or missing runtime assets.
