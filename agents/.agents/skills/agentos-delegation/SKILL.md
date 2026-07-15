---
name: agentos-delegation
description: Route and deliver project-specific work through AgentOS Tasks, Assignments, Second Mates, ship Crewmates, and scout Crewmates. Use before accepting, planning, investigating, coding, auditing, assigning, briefing, spawning, merging, handing off, completing, or retiring delegated project work.
---

# Delegate AgentOS work

Keep the Mate on coordination and every project change inside a bounded worker context.
Use released PostgreSQL schema for durable coordination and released runtime primitives for execution.

## Intake

1. Resolve the authenticated Mate with `agentos.current_agent_id()` and verify the role and active hierarchy before mutation.
2. Resolve the project independently from the current request.
   Prefer an explicit project, then an unambiguous follow-up, then the registered project scopes and a read-only repository inspection.
   Ask one short question when multiple projects remain plausible.
3. Distinguish conversation from accepted work.
   An Inbox request, comment or idea does not become accepted work until a Task exists.
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
- Use a **scout Crewmate** when the durable output is knowledge: investigation, planning, reproduction or audit.
  A scout does not open a PR unless the Captain later promotes the result into a ship task.
- Never retain project work on the Mate because it appears small, urgent or easier than delegation.
- Only First Mate may use the narrow AgentOS self-maintenance exception in its `AGENTS.md`, and only while it has no active direct report.
  Second Mate has no equivalent exception.

## Prepare the work

1. Inspect the target repository's instructions, toolchain, delivery path and current Git state read-only.
2. Select a reviewed harness, model, effort and image that fit the task and recorded Captain policy.
   Keep First and Second Mates on Pi; permit a worker harness only when the selected release verifies it.
   Require remote images to be approved and pinned by digest.
3. Ensure the target Agent identity is active and inside the caller's managed hierarchy.
   If the selected release lacks an authorized Agent-provisioning primitive, request the parent Mate to provision it; never bypass grants or invent SQL.
4. Create the Task and active Assignment before starting asynchronous work.
   Set `created_by_agent_id` and `assigned_by_agent_id` to the authenticated Mate and include concise explanatory status text.
5. Give the worker a brief containing the outcome, acceptance criteria, constraints, authority, project path, isolation requirement, delivery mode and reporting contract.
   Put long context in a durable file or Task body rather than a terminal message.
6. For project work, require an isolated worktree based on a clean reviewed base and prove it is not the Mate's primary checkout before any mutation.
7. Start the worker only through a runtime primitive implemented by the selected AgentOS release.
   Confirm its Agent identity, Task Assignment, PVC, pod and Herdr session without treating terminal text as durable state.
8. Load `$agentos-supervision` immediately after dispatch.

## Communicate and steer

- Keep ordinary progress inside Task and Assignment state.
- Use Inbox for questions, decisions, replies and concise upward handoffs.
- Report only decisions, blockers, material phase changes, completion and failure; every status change needs useful status text.
- Treat a Herdr send as an immediate hint, not durable delivery.
  Pair any material instruction with Inbox or Task state.
- Let delegated agents report upward.
  Do not make them proactively address the Captain; reconcile direct Captain intervention as authoritative input.
- Send one concise steer when the existing brief already answers a question.
  Load `$agentos-supervision` and `$agentos-runtime` before interrupting or recovering a worker.

## Deliver and close

### Ship work

1. Require the worker to inspect its complete diff, run the project's proportionate verification and preserve project-intrinsic learnings in the project's own instruction surface through the same change.
2. Require commits and remote delivery according to the project's reviewed workflow.
3. Present review-ready work to the Captain with the full remote URL, outcome, evidence and material risk.
4. Merge only after explicit Captain approval or an exact durable standing authorization.
   Destructive, irreversible and security-sensitive actions always require direct approval.
5. Treat work as landed only when Git and its remote prove the intended change durable.
   Never infer landing from a clean worktree, a terminal claim or an open PR.

### Scout work

1. Require a durable report linked from the Task.
2. Relay the findings through the owning Mate.
3. Discard the declared scratch worktree only after the report is durable.
4. If the Captain wants implementation, create or promote a ship Task while preserving the useful reproduction and context.

### Final state

1. Apply coupled Task, Assignment and Inbox mutations in one short transaction when they represent one outcome.
2. End the Assignment with explanatory status and timestamp.
   Completed Assignments are immutable; create a new Assignment for later work.
3. Complete or archive the Task only when the accepted outcome is actually complete.
4. Keep Agent retirement separate from task completion.
   Complete or reassign every active Assignment and hand off every active child before calling `agentos.retire_agent`.
5. Remove a worktree or home only after its work is landed or explicitly discarded by the Captain.

Load `$agentos-database` for exact grants, RLS, transaction and retirement behavior.
Load `$agentos-runtime` for exact worktree, pod, Herdr and recovery primitives.
