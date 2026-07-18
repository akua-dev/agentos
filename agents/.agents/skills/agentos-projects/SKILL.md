---
name: agentos-projects
description: Resolve and safely change an AgentOS project's local and remote lifecycle. Use before registering, cloning, creating, initializing, changing delivery or autonomy posture, removing, or reconciling a project checkout or provider repository.
---

# Manage an AgentOS project

Use PostgreSQL for the project registry and native Git plus the provider's
reviewed CLI for repositories. Do not add an AgentOS project wrapper.

## Resolve before mutation

1. Resolve the source, unused destination, project scope, intended audience,
   reviewed delivery workflow, merge authority and autonomy posture.
2. Inspect existing registry rows, checkouts, remotes and relevant Second-Mate
   charters. Project access is non-exclusive; registration does not assign every
   task in a repository to one Mate.
3. Ask before remote creation, credentials, cost, destructive removal or any
   outward effect not already covered by exact durable authority.
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

## Deliver and reconcile

The selected project workflow owns validation, PR, local delivery and approval
rigor. Risk can justify recommending a different path; it does not authorize a
parallel Mate-added review gate. Use direct native provider commands, observe
failure before updating local Task state, and retain full remote URLs.

## Remove

1. Obtain explicit Captain authority.
2. Inspect active and queued Tasks, Assignments, Second-Mate scope, worktrees,
   dirty state, unpushed commits, linked external work and other durable
   dependencies.
3. Refuse removal while any dependency or unlanded work exists. A failed remote
   lookup is not positive proof that deletion is safe.
4. Use only a reviewed guarded native path. If the selected release has none,
   report the capability boundary and preserve the registry, checkout and work.
