# AgentOS repository development boundary

This file governs changes to the AgentOS repository. It selects no Agent
identity and grants no authority to write, merge, deploy, restart workloads or
mutate infrastructure. A nearer `AGENTS.md` adds the rules for its subtree; the
First- and Second-Mate role files remain authoritative for their identities.

Before changing AgentOS:

- Read `VISION.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`,
  `.agents/skills/agentos-development/SKILL.md` and every nearer
  `AGENTS.md` that covers the files in scope.
- Inspect the current worktree and preserve unrelated or unfinished work.
- Keep the change inside the smallest component that owns the behavior.

Repository-wide constraints:

- Keep each contract in one source of truth: identity and permanent safety in
  the closest `AGENTS.md`, conditional judgment in one Skill, deterministic
  mechanics in versioned SQL or TypeScript, and contributor procedure in
  `CONTRIBUTING.md`. Other documentation may link or give one deliberate risk
  reminder, but must not duplicate the workflow.
- Use PostgreSQL, Kubernetes, Herdr, Git, PVCs and provider tools through their
  native interfaces. Do not introduce an AgentOS CLI wrapper, shadow state,
  daemon, controller or background service without an explicitly reviewed
  design that requires it.
- Keep runtime automation in Bun and TypeScript. Do not add repository-owned
  shell scripts or hide programs in shell-backed Mise task strings.
- Never place credentials in Git, prompts, argv, persisted task requests,
  generated artifacts or logs. Use the authority's approved environment,
  file, secret or login mechanism.
- Test observable behavior through public interfaces. Do not add tests that
  merely assert that implementation files contain selected strings.
- Treat prose as guidance, not proof that a command, schema, manifest or
  lifecycle exists. Inspect the implementation and fail closed at an
  unverified boundary.
- Do not discard changes, rewrite history, commit, push, merge, publish or
  mutate external systems unless the current task explicitly authorizes it.

When a rule is specific to one subtree, move it to that subtree's `AGENTS.md`
instead of expanding this file.
