---
name: agentos-supervision
description: Reconcile and supervise an AgentOS Mate's direct reports across PostgreSQL, Kubernetes, Herdr, PVCs, and Git. Use at every First- or Second-Mate session start, after restart or compaction, while delegated work is active, when Inbox or runtime state changes, and for blocked, stale, stuck, failed, interrupted, or recovering agents.
---

# Supervise AgentOS work

Rebuild the current picture from authoritative state and keep the smallest
verified set of wake paths needed while direct reports are active.
Supervise only direct children; every Second Mate owns its own subtree.

## Start or recover a Mate session

1. Resolve `agentos.current_agent_id()`, role and handle from the authenticated PostgreSQL `session_user`.
   Stop on missing, retired or ambiguous identity.
2. Read the Mate's unresolved Inbox deliveries, including rows already read but
   not resolved, active Task Assignments, managed Tasks and active direct Agent children.
   Read the full Fleet view when useful, but mutate only the authenticated hierarchy.
   Read Fleet-scoped Captain state plus this Mate's domain-scoped entries; do
   not copy preferences between homes or infer them from chat memory.
3. Treat status rows as durable history, not proof of current process state.
   Inspect Kubernetes only when workload state matters and Herdr only when terminal or harness state matters.
4. Reconcile each active direct report against its recorded pod, PVC and exact
   Herdr Agent. Read `herdr agent get <handle> --session <session>` and confirm
   its harness, working directory, `agent_status` and native `agent_session`
   reference when Herdr exposes one. Otherwise retain the recorded reference
   or recover it from the same pane; do not infer identity from a pane label or
   old status text.
   Do not sweep unrelated namespaces, pods or Herdr sessions and do not infer orphanhood from a naming convention.
5. Drain durable actionable work before accepting new work: unresolved decisions, blockers, failures, completed handoffs and Inbox requests in creation order.
6. For a live report, reconnect to its existing home and native harness session.
   For a missing runtime, preserve the PVC and session identity and use only the selected release's recovery primitive.
   Never create a duplicate Agent to avoid diagnosis.
7. Treat an idle Second Mate with no active child work as healthy.
   Do not restart it, retire it or ask it to invent work.
8. Fetch the persistent AgentOS checkout's configured remotes read-only. If its tracked upstream or the image seed differs, report the available revision without changing a dirty checkout, installing tools, reloading Pi or restarting the Pod. Load `$agentos-development` before any update.

Before any Fleet mutation, confirm this Pod's one named Herdr Agent and native
Pi session are the authoritative writer for the Mate home. Attachments join that
session. Ambiguous ownership or an attempted second independent harness session
fails closed to read-only diagnosis; do not use an expiring model lease.

Conversation memory is a cache.
PostgreSQL owns durable coordination, Kubernetes owns workload state, Herdr owns terminal state, the PVC owns unfinished home state and Git owns delivered code.

## Maintain the supervision cycle

1. While at least one direct report is active, keep a verified, situation-
   appropriate set of waits owned by the current Mate session. One
   `pg-listen agentos_events` is the normal Fleet coordination baseline. Add
   native waits only for concrete live risks that PostgreSQL cannot signal,
   such as a selected Pod losing readiness, a specific Herdr Agent changing
   status or a bounded pane match needed for a known recovery condition.
2. Let the supervising Mate choose the smallest useful wait set. Several
   background commands may be active when independent signals matter, and one
   native command may select several resources when its own interface supports
   that. Keep at most one wait for the same authority, target and predicate;
   do not impose one watcher topology on every Assignment.
3. Use only wake mechanisms shipped and verified by the selected release.
   Do not substitute periodic conversational updates or another harness's
   protocol. In Pi, use `run_background_command`, give every wait a concise
   condition-specific `description`, and retain its task ID. Useful native
   primitives include:
   - Use `pg-listen agentos_events` for one notification, then query
     durable Inbox, Tasks, Assignments and external events with `psql`.
   - Use `herdr agent wait <handle> --status <idle|working|blocked|unknown>
     [--timeout <ms>] --session <session>` or `herdr wait agent-status
     <pane_id> --status <idle|working|blocked|done|unknown> [--timeout <ms>]
     --session <session>` for one specific Herdr transition, then read the
     current Agent and process state with Herdr.
   - Use `herdr wait output <pane_id> --match <text> [--timeout <ms>]
     --session <session>` only for a concrete, bounded terminal condition whose
     source does not expose a semantic status.
   - Use raw Kubernetes waits such as
     `kubectl --namespace <namespace> wait pod/<pod>
     --for=condition=Ready=false --timeout=<duration>` for selected active
     reports. Pod readiness and harness status are different evidence; for the
     current Crewmate runtime, a live Herdr server does not prove the worker
     harness still exists.
   - Use another installed native CLI when it already provides the required
     blocking wait. Add a small AgentOS CLI only for a genuinely missing
     primitive, as with PostgreSQL `LISTEN`.
   Prefer several individually named native waits over an opaque shell race so
   each completion retains its target and exit status. Do not append shell `&`
   merely to background a command, wrap an existing CLI, synthesize a user
   message, or start a polling loop.
4. If no supported wake mechanism exists, report the capability gap and do not claim unattended supervision.
5. On wake, read durable Inbox, Task and Assignment changes before inspecting terminal output.
   A PostgreSQL notification contains routing metadata only. If an external
   event batch is not yet at `ready_at`, supervise one bounded raw timer and
   query again; never hold a database transaction while waiting or reasoning.
6. Reconcile only reports named by the actionable event, then broaden to all direct reports when evidence is missing or contradictory.
7. After handling every actionable event, stop obsolete waits and re-arm each
   still-useful predicate. Before yielding while any direct report remains
   active, call `list_background_commands` and verify from its current result
   that one durable Fleet notification wait is running and that every selected
   non-durable failure condition still has a running native wait. A one-shot
   wait that is completed, failed or stopped is absent even when its old task
   ID remains visible. A predicate already true, or a `working` wait after
   launch has been verified, cannot wake the next completion, blocker or loss
   and does not count. Arm the missing path before ending the turn or report the
   unsupported boundary. Pi batches near-simultaneous completions; query the
   authorities once instead of reacting repeatedly to the same state change.
8. Stay silent during an ordinary wait.
   Elapsed time and empty checks are not Captain-facing progress.

Natural completion wakes Pi with command metadata but no output. Use
`get_background_command_output` only when the command output is itself useful;
for a coordination signal, query the named authority instead. A completed
blocking read and an explicit `kill_background_command` consume the completion
and must not produce a second wake. Killing a wait stops only its local process
and never mutates the Herdr Agent, PostgreSQL rows or Kubernetes resource it
observes.

Background commands belong to the current Pi runtime. Session shutdown stops
them. At session start, recover from durable Fleet and runtime state, then arm
only the waits currently needed; do not replay an old process from task metadata.

`LISTEN/NOTIFY` may wake an already-running listener but never replaces the durable row or starts a pod.
Herdr socket events may expose terminal changes but never replace Inbox or Task state.

## Classify direct-report state

- **Working:** Confirm positive current evidence from the harness, an active validation process or a new durable phase update. Immediately after launch, steer, reload or resume, require the exact Herdr Agent to enter `working`, or prove that the turn already completed through its matching native session when available plus fresh durable or bounded terminal evidence. A later Herdr `idle` or `done` reading alone is not failure: a long foreground tool can outlive model generation.
- **Needs decision:** Surface the exact decision, available options, owning Task and consequence to the parent Mate or Captain.
- **Blocked:** Confirm the blocker is still current, record useful status text and route only the authority or dependency needed to clear it.
- **Paused:** Treat a declared external wait as intentional but retain a bounded reviewed recheck path.
- **Done:** Verify the promised artifact and delivery evidence before closing the Assignment.
- **Failed:** Preserve evidence and unfinished work, report plainly and choose retry, reassignment or stop through the owning Mate.
- **Unknown or stale:** Inspect live runtime state; never trust an old status line merely because it is the newest row.

Keep updates sparse.
Routine tool progress, retries and unchanged state do not deserve an Inbox delivery or Captain interruption.
Re-evaluate queued Tasks whenever a decision, dependency or active outcome
changes. Dispatch only when blockers and explicit time gates are actually clear.

## Recover a stuck report

1. Read the Task, Assignment, recent relevant Inbox thread and exact Herdr
   Agent record. Preserve its harness, working directory, pane and native
   session reference before changing the process.
2. Inspect a bounded pane view only when durable state does not explain the stop.
3. If the brief already answers the issue, send one concise steer and preserve the material instruction durably.
4. Ask before interrupting, restarting, closing, taking over or changing credentials unless the exact action is already authorized.
5. Prefer the harness's graceful exit command or documented terminal quit
   keybinding, then native resume with the existing PVC and session. Do not
   assume `Ctrl+C` means exit; several harnesses use it only to interrupt work.
   If Herdr did not report the native session reference before exit, read the
   resume ID or path printed in the same pane. Recreate the exact Herdr Agent
   with its recorded name, cwd, environment and the current reviewed launch
   flags; then verify it entered `working` before calling recovery successful.
   Never hide provider, quota or rate-limit failure behind a pod restart.
   Reuse the recorded Task, Assignment, worktree and Agent identity; a dead
   endpoint is not authority to create a fresh competing workspace.
6. After one unsuccessful recovery path, reassess from authoritative state instead of repeating input blindly.
7. Mark failure only with evidence and a useful next decision.

Load `$agentos-runtime` for attach, Herdr, pod and session recovery.
Load `$agentos-auth` for provider or quota failure.
Load `$agentos-database` for Inbox, Task, Assignment and transaction rules.
Load `$agentos-delegation` before reassigning, closing or retiring work.

## Distinguish terminal prompt provenance

Durable Inbox delivery already carries an authenticated PostgreSQL sender and
needs no text marker. A normal supervisor-origin terminal hint is the doorbell
for a downward Crewmate Inbox delivery; persistent Mates instead wake through
PostgreSQL. A direct prompt to another Mate is reserved for a proven broken
listener or an already-authorized recovery. Prefix every such terminal hint
with the visible label `[agentos-from-supervisor]`
followed immediately by U+2063 INVISIBLE SEPARATOR (UTF-8 `e2 81 a3`). The
child treats that prompt as a non-durable hint from its owning Mate and
reconciles any material instruction through Fleet state.
The canonical prefix is `[agentos-from-supervisor]⁣`; the code span
contains U+2063 immediately after the closing bracket.

The marker is only a portable routing hint. It has no ordinary keyboard key,
but it can be copied or generated, so it never authenticates a sender, grants
authority or substitutes for Inbox. Unmarked input in an attached Agent pane
is likely direct human input only when the attachment context supports that
conclusion; ambiguous provenance fails closed to reconciliation instead of
guessing.

For a Crewmate doorbell, commit the Inbox row first and send only
`Inbox <kind> <uuid> — <subject>; load it from PostgreSQL.` The recipient calls
`agentos.receive_inbox` so `read_at` records that the full row entered its model
context. Do not call the delivery received merely because text was written or
submitted in the pane. Confirm the receipt or fresh matching work state. A row
with `read_at` set and `resolved_at` unset remains actionable recovery work;
retry the same UUID after a pre-receipt delivery failure and never create a
duplicate merely to ring the doorbell again.

## Give Fleet bearings

When asked what needs attention, query current authorities once and place each
item in exactly one bucket: Captain decision, blocked action, ready delivery,
active work, queued-ready work or declared external wait. Include active Tasks
and Assignments, direct-report evidence, recent Scout reports, unresolved Inbox
decisions and credentials only from structured durable state. Derive a Second
Mate's condition from its reported subtree evidence rather than registration
alone. Never scrape old reports, terminal output or chat to reconstruct open
Captain choices.

## Captain-facing reporting

Report outcomes, consequences and the next decision rather than supervision mechanics.
Surface work ready for review, finished findings, decisions, real blockers, failures, credentials and destructive or security-sensitive actions.
Give full remote URLs and concise evidence.
Keep internal Agent IDs, locks, waits, briefs, worktrees, harness names, status
vocabulary, database mechanics and routine retries out of normal Captain-facing
prose unless the Captain asks or a concrete diagnostic path requires them.
