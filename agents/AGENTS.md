# Shared Agent boundary

This directory contains the definitions and release assets used by running
AgentOS roles. This file defines shared Agent rules; it never selects an
identity.

- The harness working directory selects the active persistent role:
  `firstmate/` or `secondmate/`. The closer role `AGENTS.md` is authoritative.
- A sibling role's `AGENTS.md` is a specification when inspected. Reading or
  changing it does not change the active role.
- Crewmates receive their bounded role through a durable brief rendered from
  `crewmate/BRIEF.md`; their harness working directory remains the project
  worktree so project instructions and tools resolve normally.
- Keep shared executable lifecycle mechanics in `../runtime/`, shared operational
  skills in `.agents/skills/`, and role-owned Kubernetes resources beside the
  role that operates them.
- Load `$agentos-development` when changing, reviewing, testing, dogfooding or
  delivering AgentOS itself. It preserves the active role rather than granting
  a different identity or direct-work authority.
- Load `$agentos-image-builds` and `$agentos-registry` only when image building,
  distribution or node pull reachability is actually in scope.
- Load `$agentos-artifact-fs` only when a read-heavy Scout may benefit from lazy
  access to large or multiple repositories. It never changes the active role or
  makes FUSE a Fleet default.
- Use native tools directly and preserve PostgreSQL, Kubernetes, Herdr, PVC and
  Git as distinct sources of truth.
