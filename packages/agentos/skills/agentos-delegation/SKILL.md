---
name: agentos-delegation
description: Route and deliver project-specific work through AgentOS Tasks, Assignments, Second Mates, ship Crewmates, and scout Crewmates. Use before accepting, planning, investigating, coding, auditing, assigning, briefing, spawning, merging, handing off, completing, or retiring delegated project work.
---

# Delegate AgentOS work

Keep the Mate on coordination and every project change inside a bounded worker context.
Use released PostgreSQL schema for durable coordination and native tools against released runtime assets for execution.

## Intake

1. Resolve the authenticated Mate with `agentos.current_agent_id()` and verify
   the role, active hierarchy and released schema before mutation. If Fleet
   identity or schema verification is incomplete, stop intake and resume
   bootstrap; never fall back to a tracker, transcript or local file for
   accepted work.
2. Resolve the project independently from the current request.
   Prefer an explicit project, then an unambiguous follow-up, then the registered project scopes and a read-only repository inspection.
   Ask one short question when multiple projects remain plausible.
   Load `$agentos-projects` when the registry, checkout, remote or delivery
   posture must change; intake itself grants no outward project authority.
   Resolve the selected delivery workflow, its concrete review artifact and
   merge authority before accepting ship work. For Agent-authored pull-request
   delivery without an exact recorded alternative, select the no-mistakes
   default owned by `$agentos-projects`; never infer a direct-PR path from
   missing project prose.
3. Distinguish conversation from accepted work.
   An Inbox request, provider comment or idea does not become accepted work
   until the Task's first accountable Assignment exists. An unassigned Task is
   deliberate backlog only. Keep raw reasoning and harness transcripts out of
   Inbox; persist only durable speech acts whose meaning Task or Assignment
   state cannot express. Use the released `inbox.kind` vocabulary; never invent
   a synonym. Record blockers, phase changes and completion in work state first.
4. Query active Tasks and Assignments before creating another row.
   Reuse the existing Task for the same outcome. Accept an unassigned backlog
   Task through the released Function; preserve Assignment history for work
   that was already accepted. Use `parent_task_id` for a genuinely distinct
   child outcome.
5. Keep dependency judgment coarse.
   Serialize overlapping writes or explicit outcome dependencies; allow
   independent work to proceed concurrently. A degraded shared model-capacity
   path does not itself make otherwise independent Tasks depend on its repair.
   Resolve the viable approved capacity path for each Assignment and block only
   the work that actually lacks one.

## Choose the delegate

- From First Mate, route work to one existing Second Mate when its charter clearly matches the nature of the request.
  Project membership alone does not imply exclusive ownership.
- From Second Mate, delegate only to a Crewmate inside the charter and managed Agent subtree.
  Never create or route to another Second Mate.
- Use a **ship Crewmate** when the durable output is a delivered project change.
  For a remote-backed project, accepted ship authority includes committing the
  task branch and letting the reviewed workflow push that branch and create or
  update its review artifact. It excludes default-branch push and merge.
- Use a **scout Crewmate** when the durable output is knowledge: investigation, planning, reproduction or audit.
  A scout does not open a PR unless the Captain later promotes the result into a ship task.
- Reject or reclassify a proposed ship when its constraints forbid every
  selected delivery path. Do not dispatch an Assignment whose work kind and
  Definition of Done contradict each other.
- For a reported defect, load `$agentos-diagnostics` before writing the Scout
  brief and again before accepting its causal explanation.
- Load `$agentos-artifact-fs` only when a read-heavy Scout must enter large or
  multiple repositories quickly enough to justify a separate FUSE-enabled
  image and reviewed Pod profile. Native Git remains the default.
- Never retain project work on the Mate because it appears small, urgent or easier than delegation.
- Only First Mate may use the AgentOS self-maintenance exceptions in its
  `AGENTS.md`. The ordinary exception requires no active direct report. With
  direct reports present, use the narrower delegation-capacity recovery path
  only when all of these are true:
  1. a shared AgentOS runtime, authentication or model-capacity failure prevents
     a capable delegate from starting or continuing the exact AgentOS repair;
  2. the Captain explicitly authorizes First Mate to perform that bounded
     repair;
  3. every direct report and its unfinished work remains preserved;
  4. each active report is quiescent or blocked and every still-required
     supervision wait is armed; and
  5. the direct change is limited to restoring the failed capacity through the
     normal reviewed AgentOS delivery path.
  Stop hands-on work for a supervision event, a new Captain decision or a
  boundary outside the approved repair. Never copy Mate credentials into a
  child and never infer merge authority. If any condition is absent, delegate
  the repair or block only the affected work. Second Mate has no equivalent
  exception.

## Prepare the work

1. Inspect the target repository's instructions, toolchain, delivery path and
   current Git state read-only. For remote-backed ship work, verify the selected
   workflow, Git remote, required provider authentication and delivery tooling
   before dispatch; load `$agentos-projects` and `$agentos-auth` where needed.
   With organization-owned GitHub App identity, provision only the Assignment's
   required repositories and permissions through the auth Skill. A child that
   lacks scope requests the exact delta upward; it never receives First Mate's
   App key or silently falls back to another identity.
2. Select the smallest reviewed Crewmate setup that fits the task, relevant
   private Mate guidance and exact Task or Inbox authority. Resolve the concrete
   harness, instruction and Skill sources, native settings and non-secret
   capability requirements before acceptance. Record these choices and their
   operational constraints in the complete brief.
   Keep First and Second Mates on Pi; permit a worker harness only when the selected release verifies it.
   Require remote images to be approved and pinned by digest.
   Load `$agentos-harnesses`; consult relevant natural-language dispatch
   guidance through `$agentos-memory` on every intake and record the concrete
   resolution on the Assignment. Resolve the model-capacity guidance and exact
   Inbox authority at the same time. Select the recommended AI Gateway path
   when its guidance is recorded and healthy, or direct
   authentication owned by this worker. Direct per-Agent authentication remains
   the recovery path when shared capacity is degraded. After the exact login is
   authorized, deliver provider-supported device instructions through the
   authenticated Captain surface according to `$agentos-auth` and
   `$agentos-ai-gateway`; do not copy another Agent's auth state. Never create an
   Assignment whose harness is expected to stop at an unresolved login prompt,
   and do not hold an unrelated Assignment behind a capacity repair when its
   own approved path is viable.
3. Ensure the target Agent identity is active and inside the caller's managed hierarchy.
   If the selected release lacks an authorized Agent-provisioning primitive, request the parent Mate to provision it; never bypass grants or invent SQL.
4. Atomically create the Task and first Assignment before starting asynchronous
   work. Call `agentos.create_task_with_assignment` for a new outcome or
   `agentos.accept_backlog_task` for a deliberately recorded unassigned Task.
   Supply stable caller-selected Task and Assignment UUIDs and read back the
   returned pair; do not emulate acceptance with separate INSERTs. Store the
   complete brief in `task_assignments.brief` and set `assignment_role` to
   `ship` or `scout` with concise explanatory status text. The brief must name the
   selected delivery workflow, delivery target, authorized outward effects,
   merge authority and achievable Definition of Done. Keep provider-specific
   workflow details as durable prose rather than an AgentOS delivery-mode enum.
   When no-mistakes is selected, ensure the chosen Crewmate setup makes
   `$agentos-projects` available and name it in the brief so the Crewmate
   receives its gate ownership and escalation contract.
5. Render the worker's harness view from the authoritative Assignment brief
   using `../../crewmates/default/BRIEF.md`. Fill every
   marker with the owning Mate, Agent, Task, Assignment, work kind, project,
   primary checkout, workspace kind, isolated workspace, outcome, acceptance
   criteria, constraints, delivery workflow, delivery target, authorized
   outward effects, merge authority, Definition of Done, selected harness,
   instruction entrypoints, Skills, runtime settings and capability
   requirements. Use explicit `None` values when no optional item is selected.
   Reject an unresolved marker or contradictory ship contract. Copy it to the Agent-owned
   `AGENTOS_BRIEF_PATH` before harness launch and regenerate it from PostgreSQL
   after loss; the PVC file is not a second authority. Put longer supporting
   context in the Task body rather than a terminal message.
6. For project work, require an isolated workspace and prove it is not the
   Mate's primary checkout before any mutation. Use Treehouse's durable
   UUID-labelled worktree lease for ship work and ordinary scouts. An
   ArtifactFS Scout may instead use only the Assignment-scoped mount prepared
   through `$agentos-artifact-fs`; its overlay is scratch state and can never be
   promoted directly into delivered work.
7. Create the dedicated workload from `../../crewmates/default/kubernetes/base`
   through a reviewed per-Agent Kustomize overlay in the owning Mate's
   namespace and native kubectl. A Second Mate must first prove that the
   namespace carries its owner-Agent label and installed workload-manager Role;
   the child overlay may not contain Namespace, Secret, RBAC, NetworkPolicy,
   quota, LimitRange or cluster-scoped resources. First Mate owns those domain
   controls. Run the `$agentos-runtime` capacity preflight before server-side
   dry-run. Treat
   `provably_blocked` as a dispatch blocker. Treat `inconclusive` as an explicit
   owning-Mate judgment: obtain the missing cluster-scoped observation from
   First Mate for retained/node-local or unusually large workloads, while an
   ordinary portable workload may proceed only with the uncertainty recorded
   and the same identity preserved through scheduler reconciliation. A
   preflight is never a reservation and never justifies creating a second Agent
   after an apply or scheduling race. Then start the
   selected harness through the pod-local Herdr CLI only after the complete
   rendered brief and required runtime inputs have reached the child home.
   Calculate the rendered brief's SHA-256 before apply and replace the
   all-zero `AGENTOS_BRIEF_SHA256` template value in the per-Agent overlay;
   never use the placeholder as a launch digest. After launch evidence matches,
   run the released `crewmate:confirm-readiness` task inside that exact Pod so
   Kubernetes readiness is bound to the Agent, Task, Assignment, brief,
   harness, Herdr session and live process.
   Confirm the selected Crewmate setup's native Skill catalog and required
   instruction entrypoints; a configured path or catalog entry alone is not
   proof that the worker loaded them. Before launch, provision and verify the selected
   direct credential or standing-authorized ai-gateway client boundary without
   copying another Agent's provider auth.
   Confirm its Agent identity, Task Assignment, PVC, pod and Herdr session without treating terminal text as durable state.
   `$agentos-runtime` must wrap the approved native apply and launch boundaries
   in the released SQL runtime operation for this exact Agent, Assignment,
   namespace, workload, render digest and retained resources. A scheduler race
   marks that same operation `recovery_required`; reconcile the existing Pod,
   PVC and worktree forward instead of creating another Agent or Assignment.
8. Load `$agentos-supervision` immediately after dispatch.

## Communicate and steer

- Keep ordinary progress inside Task and Assignment state; it is the primary
  communication channel.
- Use Inbox only for durable speech acts such as requests, questions, answers,
  approvals, notifications and escalation. Select the exact `kind` implemented
  by the released database migration rather than redefining the vocabulary here.
- Deliver Inbox rows only across one direct parent-child hierarchy edge. A
  cross-domain request travels upward to the common ancestor, which accepts or
  rejects it and creates or routes a Task in the target subtree. Never message
  a sibling or another subtree laterally to bypass that decision.
- Report only decisions, blockers, material phase changes, completion and failure; every status change needs useful status text.
- For delivery between persistent First and Second Mates, commit the durable row
  and rely on their PostgreSQL notification wait. Do not duplicate its body into
  a terminal prompt. A direct Mate terminal send is only an exceptional recovery
  hint when the listener is proven broken or an already-authorized urgent
  recovery requires it.
- For a downward delivery to a Crewmate, commit the Inbox row in a short
  transaction before touching Herdr. Then use `$agentos-runtime` to submit one
  concise doorbell to the exact idle Crewmate Agent:
  `Inbox <kind> <uuid> — <subject>; load it from PostgreSQL.` Prefix it with the
  provenance marker from `$agentos-supervision`. Never repeat the body. The
  owning direct parent sends the doorbell; a sibling or ancestor does not reach
  around the hierarchy. If Herdr delivery fails, leave the same unread row for
  retry rather than creating another message.
- Treat the Crewmate's own `receive_inbox` receipt or fresh matching work state
  as delivery evidence. Text appearing in a pane proves neither submission nor
  receipt.
- Let delegated agents report upward.
  Do not make them proactively address the Captain; reconcile direct Captain intervention as authoritative input.
- Send one concise steer when the existing brief already answers a question.
  Load `$agentos-supervision` and `$agentos-runtime` before interrupting or recovering a worker.

## Deliver and close

### Ship work

1. Require the worker to inspect its complete diff and use the project's
   selected delivery path. That path owns proportionate verification and review
   rigor; do not add a parallel Mate review gate merely because the change is
   risky. Recommend changing paths when the selected rigor is insufficient.
   Preserve durable project-intrinsic learnings in the project's own instruction
   surface through the same change, creating that memory only when real work
   produced a reusable fact and pruning stale guidance rather than appending.
2. Require commits and the selected delivery artifact according to the project's
   reviewed workflow. For remote-backed work, that workflow may own both the
   task-branch push and review-artifact creation, including through a local Git
   validation proxy such as no-mistakes.
3. Present review-ready work to the Captain only after the artifact exists, with
   its full remote URL, outcome, evidence and material risk. A local-only
   workflow instead requires its declared clean committed branch.
4. Merge only after explicit Captain approval or an exact durable standing authorization.
   Destructive, irreversible and security-sensitive actions always require direct approval.
5. Treat work as landed only when Git and its remote prove the intended change durable.
   Never infer landing from a clean worktree, a terminal claim or an open PR.

### Scout work

1. Require the complete report in `task_assignments.report`.
   Load `$agentos-decisions`, inventory genuine unresolved Captain choices and
   attest the exact key set, including an explicit empty set, before completion.
2. Relay the findings through the owning Mate.
3. Discard the declared scratch worktree or ArtifactFS mount only after the
   report is durable. Stop and unmount ArtifactFS before removing its Pod or
   scoped credentials.
4. If the Captain wants implementation, create a clean ship Task while
   preserving useful reproduction and context but none of the Scout's scratch
   commits or debug edits.

### Final state

1. Apply coupled Task, Assignment and Inbox mutations in one short transaction when they represent one outcome. When a speech act changes durable state, use
   one released idempotent Function that records the response, closes the
   delivery and applies the state effect atomically; load `$agentos-database`
   rather than splitting those writes across turns.
2. Store the final or handoff report, then end the Assignment with explanatory
   status and timestamp. Include the brief's concise runtime debrief while the
   worker still holds its task context; if the worker is unavailable,
   record that honestly and preserve only the bounded evidence needed for a
   selected independent review. For ship work, record branch, commit, review URL when
   applicable, validation result and current delivery state. Add a remote review
   URL to the Task's `external_links`; do not call the Assignment review-ready
   while its declared artifact is missing.
   Completed Assignments are immutable; create a new Assignment for later work.
3. Complete or archive the Task only when the accepted outcome is actually complete.
4. Keep Agent retirement separate from task completion.
   Complete or reassign every active Assignment and hand off every active child before calling `agentos.retire_agent`.
5. Remove a worktree or home only after its work is landed or explicitly discarded by the Captain.
   Return a Crewmate lease through the pinned Treehouse lifecycle; never
   manually delete its directory or Git metadata.
6. Remove a child StatefulSet without deleting its retained PVC. A Second Mate
   never deletes its domain Namespace; First Mate retires that Namespace only
   after every retained PVC has separate explicit discard approval.

For reassignment, call the released `agentos.handoff_task_assignment` Function.
It ends the old Assignment with a report and creates one replacement for the
same Task in one transaction. Never rewrite the assigned Agent, clone the Task
or create a fresh worktree while existing ownership is ambiguous. Ship
Crewmates retire after landed work plus report; scratch Scouts may retire after
their report; First and Second Mates are never retired merely for idleness.

Load `$agentos-database` for exact grants, RLS, transaction and retirement behavior.
Load `$agentos-runtime` for exact worktree, pod, Herdr and recovery primitives.
