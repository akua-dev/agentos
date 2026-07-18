---
name: agentos-projects
description: Resolve and safely change an AgentOS project's local and remote lifecycle. Use before registering, cloning, creating, initializing, changing delivery or autonomy posture, removing, or reconciling a project checkout or provider repository.
---

# Manage an AgentOS project

Use PostgreSQL for the project registry and native Git plus the provider's
reviewed CLI for repositories. Do not add an AgentOS project wrapper.

## Resolve before mutation

1. Resolve the source, unused destination, project scope, intended audience,
   reviewed delivery workflow, concrete review artifact, merge authority and
   autonomy posture. Record them as durable project prose, not an AgentOS mode
   enum.
2. Inspect existing registry rows, checkouts, remotes and relevant Second-Mate
   charters. Project access is non-exclusive; registration does not assign every
   task in a repository to one Mate.
3. Ask before remote creation, credentials, cost, destructive removal or any
   outward effect not already covered by exact durable authority. An accepted
   remote-backed ship plus the recorded project workflow covers its task-branch
   commit, workflow-owned branch push and review-artifact creation or update; it
   never covers default-branch push or merge.
4. Keep registry and checkout consistent. On partial failure, roll back only
   artifacts created by this operation and only when they contain no work.

## Add or create

- For an existing repository, confirm the source and destination, clone with
  native Git into the selected persistent project home, verify its actual
  remote and instructions, then create the PostgreSQL project record.
- For local-only work, initialize an unused local path and create no unmentioned
  remote.
- Creating a GitHub repository requires explicit owner, name, visibility and
  delivery approval. Inspect current `gh-axi --help`, execute the approved
  operation synchronously and preserve its exit status and URL.
- Do not encode Kun's `no-mistakes`, `direct-PR` and `local-only` names as an
  AgentOS enum. Record the project's real reviewed workflow in durable prose.
  If it selects no-mistakes, use that installed version's own Skill and CLI.
  No-mistakes installs a local bare-repository Git proxy; it is not a hosted Git
  service. Its reviewed workflow may accept the local task-branch push, validate
  it, forward it to the configured provider remote and open the pull request.

## Deliver and reconcile

Before dispatching remote-backed ship work, verify the actual Git remote,
selected workflow tools and provider authentication without printing or copying
credentials. If readiness is missing, keep the Task queued or blocked and load
`$agentos-auth`; do not create a worker whose Definition of Done is unreachable.

The selected project workflow owns validation, task-branch push, review
artifact, local delivery and approval rigor. Risk can justify recommending a
different path; it does not authorize a parallel Mate-added review gate. Use
native Git, the selected workflow and reviewed provider commands directly,
observe failure before updating local Task state, and retain full remote URLs.
If readiness expires after implementation, preserve the committed branch and
active Assignment while reporting the concrete blocker.

## Remove

1. Obtain explicit Captain authority.
2. Inspect active and queued Tasks, Assignments, Second-Mate scope, worktrees,
   dirty state, unpushed commits, linked external work and other durable
   dependencies.
3. Refuse removal while any dependency or unlanded work exists. A failed remote
   lookup is not positive proof that deletion is safe.
4. Use only a reviewed guarded native path. If the selected release has none,
   report the capability boundary and preserve the registry, checkout and work.
