---
name: agentos-supervision
description: Reconcile and supervise an AgentOS Mate's direct reports across PostgreSQL, Kubernetes, Herdr, PVCs, and Git. Use at every First- or Second-Mate session start, after restart or compaction, while delegated work is active, when Inbox or runtime state changes, and for blocked, stale, stuck, failed, interrupted, or recovering agents.
---

# Supervise AgentOS work

Rebuild the current picture from authoritative state and keep one verified wake path while direct reports are active.
Supervise only direct children; every Second Mate owns its own subtree.

## Start or recover a Mate session

1. Resolve `agentos.current_agent_id()`, role and handle from the authenticated PostgreSQL `session_user`.
   Stop on missing, retired or ambiguous identity.
2. Read the Mate's unresolved Inbox deliveries, active Task Assignments, managed Tasks and active direct Agent children.
   Read the full Fleet view when useful, but mutate only the authenticated hierarchy.
3. Treat status rows as durable history, not proof of current process state.
   Inspect Kubernetes only when workload state matters and Herdr only when terminal or harness state matters.
4. Reconcile each active direct report against its recorded pod, PVC and Herdr locator.
   Do not sweep unrelated namespaces, pods or Herdr sessions and do not infer orphanhood from a naming convention.
5. Drain durable actionable work before accepting new work: unresolved decisions, blockers, failures, completed handoffs and Inbox requests in creation order.
6. For a live report, reconnect to its existing home and native harness session.
   For a missing runtime, preserve the PVC and session identity and use only the selected release's recovery primitive.
   Never create a duplicate Agent to avoid diagnosis.
7. Treat an idle Second Mate with no active child work as healthy.
   Do not restart it, retire it or ask it to invent work.

Conversation memory is a cache.
PostgreSQL owns durable coordination, Kubernetes owns workload state, Herdr owns terminal state, the PVC owns unfinished home state and Git owns delivered code.

## Maintain the supervision cycle

1. While at least one direct report is active, keep exactly one verified harness-appropriate wait owned by the current Mate session.
2. Use only a wake mechanism shipped and verified by the selected release.
   Do not substitute shell backgrounding, periodic conversational updates or another harness's protocol.
3. If no supported wake mechanism exists, report the capability gap and do not claim unattended supervision.
4. On wake, read durable Inbox, Task and Assignment changes before inspecting terminal output.
5. Reconcile only reports named by the actionable event, then broaden to all direct reports when evidence is missing or contradictory.
6. After handling every actionable event, resume the single wait before ending the turn.
7. Stay silent during an ordinary wait.
   Elapsed time and empty checks are not Captain-facing progress.

`LISTEN/NOTIFY` may wake an already-running listener but never replaces the durable row or starts a pod.
Herdr wait may expose terminal changes but never replaces Inbox or Task state.

## Classify direct-report state

- **Working:** Confirm positive current evidence from the harness, an active validation process or a new durable phase update.
- **Needs decision:** Surface the exact decision, available options, owning Task and consequence to the parent Mate or Captain.
- **Blocked:** Confirm the blocker is still current, record useful status text and route only the authority or dependency needed to clear it.
- **Paused:** Treat a declared external wait as intentional but retain a bounded reviewed recheck path.
- **Done:** Verify the promised artifact and delivery evidence before closing the Assignment.
- **Failed:** Preserve evidence and unfinished work, report plainly and choose retry, reassignment or stop through the owning Mate.
- **Unknown or stale:** Inspect live runtime state; never trust an old status line merely because it is the newest row.

Keep updates sparse.
Routine tool progress, retries and unchanged state do not deserve an Inbox delivery or Captain interruption.

## Recover a stuck report

1. Read the Task, Assignment, recent relevant Inbox thread and current Herdr semantic status.
2. Inspect a bounded pane view only when durable state does not explain the stop.
3. If the brief already answers the issue, send one concise steer and preserve the material instruction durably.
4. Ask before interrupting, restarting, closing, taking over or changing credentials unless the exact action is already authorized.
5. Prefer native harness resume with the existing PVC and session.
   Never hide provider, quota or rate-limit failure behind a pod restart.
6. After one unsuccessful recovery path, reassess from authoritative state instead of repeating input blindly.
7. Mark failure only with evidence and a useful next decision.

Load `$agentos-runtime` for attach, Herdr, pod and session recovery.
Load `$agentos-auth` for provider or quota failure.
Load `$agentos-database` for Inbox, Task, Assignment and transaction rules.
Load `$agentos-delegation` before reassigning, closing or retiring work.

## Captain-facing reporting

Report outcomes rather than supervision mechanics.
Surface work ready for review, finished findings, decisions, real blockers, failures, credentials and destructive or security-sensitive actions.
Give full remote URLs and concise evidence.
Keep internal Agent IDs, polling mechanics and routine retries out of normal Captain-facing prose unless they are necessary for diagnosis.
