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
   merge authority before accepting ship work.
3. Distinguish conversation from accepted work.
   An Inbox request, provider comment or idea does not become accepted work
   until a Task exists. Keep raw reasoning and harness transcripts out of Inbox;
   persist only durable speech acts whose meaning Task or Assignment state
   cannot express. Use the released `inbox.kind` vocabulary; never invent a
   synonym. Record blockers, phase changes and completion in work state first.
4. Query active Tasks and Assignments before creating another row.
   Reuse the existing Task for the same accepted outcome; use `parent_task_id` for a genuinely distinct child outcome.
5. Keep dependency judgment coarse.
   Serialize overlapping writes or explicit dependencies; allow independent work to proceed concurrently.

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
- Only First Mate may use the narrow AgentOS self-maintenance exception in its `AGENTS.md`, and only while it has no active direct report.
  Second Mate has no equivalent exception.

## Prepare the work

1. Inspect the target repository's instructions, toolchain, delivery path and
   current Git state read-only. For remote-backed ship work, verify the selected
   workflow, Git remote, required provider authentication and delivery tooling
   before dispatch; load `$agentos-projects` and `$agentos-auth` where needed.
2. Select a reviewed harness, model, effort and image that fit the task and recorded Captain policy.
   Keep First and Second Mates on Pi; permit a worker harness only when the selected release verifies it.
   Require remote images to be approved and pinned by digest.
   Load `$agentos-harnesses`; consult scoped natural-language dispatch policy
   on every intake and record the concrete resolution on the Assignment.
3. Ensure the target Agent identity is active and inside the caller's managed hierarchy.
   If the selected release lacks an authorized Agent-provisioning primitive, request the parent Mate to provision it; never bypass grants or invent SQL.
4. Create the Task and active Assignment before starting asynchronous work.
   Set `created_by_agent_id` and `assigned_by_agent_id` to the authenticated
   Mate, store the complete brief in `task_assignments.brief`, store harness and
   any selected model, effort or immutable image in `dispatch_profile`, and
   set `assignment_role` to `ship` or `scout` with concise explanatory status
   text. The brief must name the selected delivery workflow, delivery target,
   authorized outward effects, merge authority and achievable Definition of
   Done. Keep provider-specific workflow details as durable prose rather than an
   AgentOS delivery-mode enum.
5. Render the worker's harness view from the authoritative Assignment brief
   using `../crewmate/BRIEF.md`. Fill every
   marker with the owning Mate, Agent, Task, Assignment, work kind, project,
   primary checkout, workspace kind, isolated workspace, outcome, acceptance
   criteria, constraints, delivery workflow, delivery target, authorized
   outward effects, merge authority and Definition of Done. Reject an unresolved
   marker or contradictory ship contract. Copy it to the Agent-owned
   `AGENTOS_BRIEF_PATH` before harness launch and regenerate it from PostgreSQL
   after loss; the PVC file is not a second authority. Put longer supporting
   context in the Task body rather than a terminal message.
6. For project work, require an isolated workspace and prove it is not the
   Mate's primary checkout before any mutation. Use Treehouse's durable
   UUID-labelled worktree lease for ship work and ordinary scouts. An
   ArtifactFS Scout may instead use only the Assignment-scoped mount prepared
   through `$agentos-artifact-fs`; its overlay is scratch state and can never be
   promoted directly into delivered work.
7. Create the dedicated workload from `../crewmate/kubernetes/base` through a
   reviewed per-Agent Kustomize overlay and native kubectl, then start the
   selected harness through the pod-local Herdr CLI with the complete rendered
   brief as its initial prompt.
   Confirm its Agent identity, Task Assignment, PVC, pod and Herdr session without treating terminal text as durable state.
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
   status and timestamp. For ship work, record branch, commit, review URL when
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

For reassignment, call the released `agentos.handoff_task_assignment` Function.
It ends the old Assignment with a report and creates one replacement for the
same Task in one transaction. Never rewrite the assigned Agent, clone the Task
or create a fresh worktree while existing ownership is ambiguous. Ship
Crewmates retire after landed work plus report; scratch Scouts may retire after
their report; First and Second Mates are never retired merely for idleness.

Load `$agentos-database` for exact grants, RLS, transaction and retirement behavior.
Load `$agentos-runtime` for exact worktree, pod, Herdr and recovery primitives.
