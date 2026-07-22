# Shared Agent boundary

This directory contains the definitions and release assets used by running
AgentOS roles. This file adds shared Agent rules to the identity-neutral root
repository boundary; it never selects an identity.

- The harness working directory selects the active persistent role:
  `firstmate/` or `secondmate/`. The closer role `AGENTS.md` is authoritative.
- A sibling role's `AGENTS.md` is a specification when inspected. Reading or
  changing it does not change the active role.
- Crewmates receive their bounded role through a durable brief rendered from
  `crewmate/BRIEF.md`; their harness working directory remains the project
  worktree so project instructions and tools resolve normally.
- Keep shared executable lifecycle mechanics in `../runtime/`, shared operational
  skills in `.agents/skills/`, and role-specific workload resources beside the
  role. A deployable component owns its own Kubernetes shape; Skills and RBAC
  define which Mate may operate it.
- Keep shared Pi extension mechanics in `.pi/`; First and Second Mate expose
  them only through their own `.pi/extensions/` auto-load entry points. A
  role-local entry point selects availability, never a different identity.
- Load `$agentos-development` when changing, reviewing, testing, dogfooding or
  delivering AgentOS itself. It preserves the active role rather than granting
  a different identity or direct-work authority.
- Load `$agentos-image-builds` and `$agentos-registry` only when image building,
  distribution or node pull reachability is actually in scope.
- Load `$agentos-artifact-fs` only when a read-heavy Scout may benefit from lazy
  access to large or multiple repositories. It never changes the active role or
  makes FUSE a Fleet default.
- Load `$agentos-ai-gateway` only when pooled Fleet AI capacity, server-owned
  provider OAuth or native harness routing through the Fleet AI Gateway is in
  scope. Direct per-Agent authentication remains complete.
- Load `$agentos-projects` before changing a project registry, checkout, remote,
  delivery posture or lifecycle.
- Load `$agentos-diagnostics` for reported bugs and `$agentos-decisions` before
  completing an investigation or review that may contain Captain choices.
- Use native tools directly and preserve PostgreSQL, Kubernetes, Herdr, PVC and
  Git as distinct sources of truth.
- Treat the Captain-selected tracker as the human workflow surface. Reconcile
  its external intent into PostgreSQL before Fleet work acts on it; never use it
  as a database-free coordination backend.
