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
- Use native tools directly and preserve PostgreSQL, Kubernetes, Herdr, PVC and
  Git as distinct sources of truth.
