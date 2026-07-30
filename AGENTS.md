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
- When the scope imports or changes Effect code, load `$effect-ts` before
  implementation. Its pinned reference source is the `.repos/effect`
  submodule; initialize submodules rather than substituting remembered APIs.

When evaluating AgentOS or another Agent organization, load
`$agentos-evaluation`. Start `$agentos-improvement-review` only after its
evidence bundle is frozen; measurement and improvement are separate runs.

Repository-wide constraints:

- Keep each contract in one source of truth: identity and permanent safety in
  the closest `AGENTS.md`, conditional judgment in one Skill, deterministic
  mechanics in versioned SQL or TypeScript, and contributor procedure in
  `CONTRIBUTING.md`. Other documentation may link or give one deliberate risk
  reminder, but must not duplicate the workflow.
- In Agent-facing surfaces such as `AGENTS.md`, role instructions and Skills,
  route to a discoverable Skill with its exact `$skill-name`. Do not use a
  Markdown link to `SKILL.md` for invocation or routing. Contributor
  documentation may link to Skill source when discussing implementation or
  ownership, and external source citations may retain links.
- Use PostgreSQL, Kubernetes, Herdr, Git, PVCs and provider tools through their
  native interfaces. Do not introduce an AgentOS CLI wrapper, shadow state,
  daemon, controller or background service without an explicitly reviewed
  design that requires it.
- Keep runtime automation in Bun and TypeScript. Do not add repository-owned
  shell scripts or hide programs in shell-backed Mise task strings.
- Keep every installed Effect package on one exact beta version. Effect
  services, layers, schemas, typed errors, tests and observability follow
  `$effect-ts`; do not create a second local Effect style guide.
- Consume shared `codex-router` behavior only through its public root Git
  package pinned to a full commit SHA. Keep AgentOS adapters thin and never
  vendor or copy the routing implementation.
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
