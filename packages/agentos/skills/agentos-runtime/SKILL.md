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
- Treat a live terminal send as an immediate hint only. Require the caller to
  supply the canonical supervisor-origin marker from its coordination
  procedure and keep durable inter-agent communication in PostgreSQL.
- Ask before interrupting, restarting, closing, taking over, or rearranging an existing user session.
- Attach to the existing named Mate session. Never launch a second independent
  Pi writer for the same home. If Pod, Herdr and native session identity do not
  agree, remain read-only until the owning Mate state is reconciled.

## Submit a Crewmate doorbell

Use this only after the owning Mate has committed a downward Inbox row. The
doorbell is not a second message body and is not the normal delivery path for a
persistent Mate.

1. Query the exact named Herdr Agent and record its pane, session and semantic
   status. If it is working or the input-buffer state is ambiguous, do not type over
   it; wait for a safe boundary or use the reviewed recovery path.
2. Submit only the canonical supervisor marker plus
   `Inbox <kind> <uuid> — <subject>; load it from PostgreSQL.` with native
   `herdr pane run <pane_id> <text> --session <session>`. This command writes
   the literal text and Enter in one operation. Do not split submission across
   `herdr agent send` and `herdr pane send-keys`; success of the first command
   does not prove that Enter was sent.
3. Verify the exact Agent enters `working` with `herdr agent wait`, or that the
   matching Inbox row acquired `read_at` before the observation. Pane text alone
   is not receipt evidence.
4. If delivery fails before receipt, preserve and retry the same Inbox UUID.
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
- Use `../secondmate/kubernetes/domain` from First Mate and
  `../../crewmates/default/kubernetes/base` from either Mate. Never apply a
  generic base
  directly: it contains visible placeholder identity and local-development
  image values.
- Use explicit `AGENTOS_AGENT_ROLE` and `AGENTOS_DISTRIBUTION_ROOT` with an
  `AGENTOS_AGENT_CWD` that exactly selects that role directory, plus
  `AGENTOS_AGENT_NAME`, `HERDR_SESSION` and the role-scoped Mise tasks to run
  the common Mate runtime. Preserve one exact named Herdr Agent and fail closed
  on duplicates.
- Allow ordinary processes beside agents in Herdr panes.
- Arrange optional fleet workspaces with Kubernetes-exec panes into remote
  pod-local Herdr sessions when requested. The remote sessions remain
  authoritative.

## Create a prepared child workload

This section consumes, but does not select or create, a provisioned Agent,
accepted Task and Assignment, database principal and approved pgpass Secret,
complete brief, selected Crewmate setup and native harness argv. Return any
missing input to the owning workflow before Kubernetes mutation; do not restart
delegation or database intake from this Skill.

1. Verify the supplied Agent, Task, Assignment, database login, Secret
   reference, brief and selected setup agree on one child identity.
2. Resolve the owning Mate's namespace, Pod and `serviceAccountName` from
   Kubernetes. For a Crewmate, require the target namespace to equal the
   owning Mate's namespace. A First Mate provisioning a Second Mate instead
   uses that Mate's reviewed `kubernetes/domain` composition and proves the
   Namespace Fleet and owner-Agent labels before applying the workload.
   Require the owner's standard projected ServiceAccount token, CA and
   namespace mounts and native in-cluster `kubectl`; never create, copy or
   persist a bearer token or generated kubeconfig for steady-state child
   supervision. Verify that a Second Mate is bound to
   `Role/agentos-secondmate-workload-manager` only in its own domain.
   Before the first managed domain is admitted, First Mate or the approved
   platform identity must server-side apply the released
   `roles/secondmate/kubernetes/admission` bundle once and verify both policies
   report no CEL type-check warnings. A Second Mate never applies that
   cluster-scoped bundle.
3. Create `$HOME/.local/state/agentos/workloads/<handle>/kustomization.yaml`.
   Reference the released child base and patch every placeholder: resource
   names, matching workload/Pod Agent, owner, Task and Assignment UUID labels,
   Herdr session, database URL and Secret, Task
   and Assignment UUIDs where applicable, storage, selected image, image
   pull policy, CPU/memory requests and limits, and explicit child
   `automountServiceAccountToken: false`. Published images require an immutable
   digest. A Crewmate
   overlay contains only its dedicated ServiceAccount, headless Service and
   retained one-replica StatefulSet; reject Namespace, Role, RoleBinding,
   NetworkPolicy, ResourceQuota, LimitRange, Secret and cluster-scoped
   resources. Its owner already receives the reviewed namespace-limited
   workload authority from the domain composition. A Second-Mate overlay is
   the one exception: First Mate composes the released domain assets and owns
   every control resource in that render.
4. Render a review artifact with native kubectl:

   ```console
   kubectl kustomize --load-restrictor LoadRestrictionsNone \
     "$HOME/.local/state/agentos/workloads/<handle>" \
     --output "$HOME/.local/state/agentos/workloads/<handle>/rendered.yaml"
   ```

5. Inspect the complete rendered resources. For a Crewmate, require exactly one
   dedicated ServiceAccount, headless Service and retained one-replica
   StatefulSet and reject every control resource named in step 3. For a Second
   Mate, additionally require the exact released Namespace, two Roles, two
   RoleBindings, ingress-only NetworkPolicy, ResourceQuota and LimitRange from
   the domain composition. Verify concrete Fleet and owner-Agent Namespace
   labels, the
   core First-Mate subject, the domain Second-Mate subject, restricted Pod
   Security labels, the immutable admission selector, no wildcard RBAC and no
   egress policy. Verify separately that the cluster admission policies and
   bindings select that label. The child Pod must
   explicitly enable its projected ServiceAccount identity when it is a
   persistent Mate that will supervise its own children. Reject placeholder
   values, public endpoints, mutable remote images and ownership conflicts.
   Compute the rendered file's SHA-256. After all required authority is present
   and before the first external mutation, use `$agentos-database` to begin one
   stable runtime operation for this Agent, owner, optional Assignment,
   namespace, workload and retained-resource set. Use action `provision` for a
   new runtime and `recover` for repair of the existing one. Reuse the same
   caller-selected operation UUID on retry; a conflict or another active
   operation is a hard stop, not a reason to mint another identity.
6. Before apply, collect fresh native Kubernetes observations without copying
   them into Fleet state: domain ResourceQuota status, domain Pods and PVCs,
   and the Nodes, cluster Pods, StorageClasses and PVs the current identity is
   authorized to read. Normalize effective current Pod requests, desired
   requests, selectors/tolerations, StorageClass binding/topology, PVC phase,
   access modes and bound-PV node affinity into capacity snapshot version `1`.
   Mark every unavailable observation `Complete: false`; never invent an empty
   list. Declare storage as `portable` or `node_local` from its reviewed
   StorageClass contract. Feed the JSON snapshot to the role task:

   ```console
   mise run secondmate:capacity-preflight < capacity-snapshot.json
   # First Mate uses: mise run firstmate:capacity-preflight
   ```

   `provably_blocked` stops dispatch. `inconclusive` records the missing fact
   and triggers owning-Mate judgment; request a cluster-scoped observation from
   First Mate rather than granting sibling Pod reads. `fits` means only that no
   modeled blocker exists at that instant. Every output carries
   `reservation=false`; Kubernetes admission and scheduling remain final.
7. Ask for any installation, cost or RBAC approval not already recorded. Then
   validate against the API server and inspect the diff:

   ```console
   kubectl --namespace <namespace> apply --server-side --dry-run=server \
     --filename "$HOME/.local/state/agentos/workloads/<handle>/rendered.yaml"
   kubectl --namespace <namespace> diff --server-side \
     --filename "$HOME/.local/state/agentos/workloads/<handle>/rendered.yaml"
   ```

   `kubectl diff` exit status `1` means a diff exists; other non-zero statuses
   are failures.
8. Apply synchronously and retain the native result:

   ```console
   kubectl --namespace <namespace> apply --server-side \
     --filename "$HOME/.local/state/agentos/workloads/<handle>/rendered.yaml"
   ```

   For a Crewmate, semantic readiness deliberately remains false before the
   brief and harness exist. Wait only for the named Pod and Herdr container to
   start at this stage; do not weaken or bypass the readiness probe to make an
   early `rollout status` pass.
   After the synchronous apply returns, record `applied` on the same runtime
   operation. If the call, session or scheduler boundary is ambiguous, record
   `recovery_required` with a stable reason, inspect the exact named resources,
   and repair this operation forward; never repeat provisioning under a new
   Agent or operation.

9. Verify observed image IDs, ServiceAccount, Pod, PVC, Secret mount, Agent
   environment and Herdr status; for a persistent Mate, also verify the
   projected token mount. From a Second Mate identity, use `kubectl auth can-i`
   to verify namespaced StatefulSet, Service and ServiceAccount creation plus
   Pod read, replacement and approved exec. Also prove denial for Namespace,
   Secret, RBAC, NetworkPolicy, ResourceQuota, LimitRange and sibling-namespace
   access. From First Mate, prove inspect, exec, stop, credential and policy
   maintenance in the domain. An external reviewer may use `--as` only when its
   current identity already has impersonation authority. A denial of required
   authority blocks unattended supervision; a network or API failure remains
   a visible failure rather than a reason to mint another token. For a
   Crewmate, create or recover the
   project and Treehouse lease inside that pod. Copy the
   PostgreSQL-authoritative brief's rendered harness view with native kubectl
   and verify its digest inside the pod:

   ```console
   kubectl --namespace <namespace> cp \
     "$HOME/.local/state/agentos/workloads/<handle>/brief.md" \
     "<pod>:/home/agent/brief.md" --container crewmate
   kubectl --namespace <namespace> exec pod/<pod> --container crewmate -- \
     sha256sum /home/agent/brief.md
   ```

   The destination must match the workload's `AGENTOS_BRIEF_PATH`, and the
   locally calculated digest must already have replaced the all-zero
   `AGENTOS_BRIEF_SHA256` template value in the per-Agent overlay. Then use
   `$agentos-harnesses` to invoke
   `herdr agent start ... -- <native-harness-argv> <brief>` through
   `kubectl exec`. After exact Herdr Agent, cwd, native session, harness process
   and brief evidence match, run
   `mise run --skip-tools crewmate:confirm-readiness -- confirm-crewmate` in
   the Crewmate container. Only then use `kubectl rollout status
   statefulset/<name>`; the confirmation is identity-, digest-, session- and
   process-bound and does not make an unverified launch ready.
   Record `workload_ready` only after the exact named Pod and Herdr runtime are
   available, then `harness_ready` only after this semantic confirmation.
10. Record verified Kubernetes and Herdr locators in Fleet state. Treat launch
   as successful only after the native harness is processing the complete brief
   without a trust or routine command-approval dialog. The owning Mate must use
   `$agentos-harnesses` to reconcile a missing unattended launch or reviewed
   repository-trust preflight instead of repeatedly pressing through ordinary
   commands. On partial failure, preserve the identity, PVC and rendered
   evidence for reconciliation; never create a replacement Agent to hide the
   error. If admission or scheduling changed after preflight, re-observe and
   reconcile this same Agent, Task, Assignment, workload and retained PVC.
   Never create a duplicate Agent to race the scheduler.
   Complete the runtime operation only after the locator transaction and
   harness-ready evidence agree. A terminal failure remains audit evidence; a
   changed desired render must atomically supersede it with one linked
   replacement operation rather than rewriting the prior row.

## Resolve tools with Mise

1. Inspect effective configuration with `mise config ls`, requested versions with `mise ls --current`, and executable ownership with `mise which <tool>` before changing tools.
2. At image build time, install the released root `mise.toml` and
   `mise.lock` as `/etc/mise/config.toml` and `/etc/mise/mise.lock`, and
   bake their pinned Bun into the image. The persistent AgentOS checkout
   supplies its reviewed root and role configuration directly; do not copy it
   into a parallel global file on the PVC. Install the remaining
   startup-critical tools before adding agent-owned entries under
   `~/.config/mise/conf.d/`; install other released tools only when the task
   needs them.
3. Prepend Mise shims to `PATH` for interactive and non-interactive processes so released tools win over unmanaged globals. Verify ordinary tool names work without a `mise exec` prefix.
4. Let configuration in the current repository or worktree add tools and override conflicting baseline versions. Do not copy AgentOS's project config into another repository.
5. Inspect repository-owned Mise configuration before trust. Ask before trusting executable hooks or environment behavior that is not already approved with the project.
6. Put approved persistent agent additions in that agent's Mise configuration on its PVC. Change a repository-owned tool version only through the repository's normal delivery workflow.
7. Do not fall back to npm-global, Homebrew, apt, or `curl | sh` when a tool is absent. Report the missing reviewed Mise asset or request the appropriate scoped configuration change.

## Reconcile a customized runtime

Load `$agentos-customization` for package and role-resource selection. This
runtime Skill supplies the Kubernetes, Herdr, PVC and execution-locality facts
needed to apply and verify that choice through native interfaces.

## Health and recovery

- Keep liveness limited to a technically functioning runtime.
- Fail readiness only for explicit, supported degradation classes on required agents; ordinary human-blocked state is not a readiness failure.
- Preserve attach access during provider, quota and rate-limit failures.
- Reuse the owned PVC and native harness session during pod replacement.
- Reconcile a stopped worker against its recorded Assignment and Treehouse
  worktree before resume. Preserve same-task work and refuse a fresh workspace
  while ownership is ambiguous.
- Query the target Agent's nonterminal runtime operation before repair. Record
  `recovery_required` when a partial native boundary is ambiguous, then inspect
  exact Kubernetes, Herdr, PVC and worktree truth and advance that same
  operation to the verified phase. Do not infer live state from the journal,
  copy native status into it, or begin a second active operation.
- Preserve the Herdr Agent's native session reference before a deliberate exit.
  For a distribution working-directory change, load `$agentos-customization`:
  it owns the transactional Pi-session relocation and rollback rather than an
  in-place header edit. Otherwise prefer the harness's documented graceful
  command or quit keybinding, then resume the native session with the current
  reviewed flags. Use Pi `/reload` only for reloadable resources, not as a
  substitute for process, environment or authentication recovery.
- Let the supervising model decide whether to retry, attach, rotate auth, change model, restart a process, or leave the agent stopped.

Use only released Kustomize assets and native tool interfaces. Fail closed on ambiguous ownership or missing runtime assets.
