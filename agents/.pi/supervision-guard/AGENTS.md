# Pi supervision guard boundary

This extension is an advisory continuity backstop for persistent Mates. It
tracks only the lifecycle evidence Pi observes for a running background command
with the released supervision marker in its useful description.

- Never select, parse, synthesize, launch, restart or replace a background
  command here. Agent guidance owns the useful native wait set.
- Never treat one running process as proof that its predicate is correct. The
  guard deliberately knows nothing about PostgreSQL, Herdr or Kubernetes wait
  semantics.
- Recognize `[agentos-supervision]` only as a marker contained inside a useful
  condition-specific description. Do not require the whole description to be
  static and do not inspect the command text.
- Remember tagged task IDs from successful start and status results, remove them
  on terminal or kill evidence, and let an explicit background-command list
  reconcile uncertain state. A complete `running` or `all` list may replace
  known running state; a filtered terminal page may only update the tasks it
  contains. Never require a list merely as turn-end ceremony.
- Force at most one follow-up per settled run. A broken check must not make Pi
  impossible to idle or block bootstrap and local development.
- At session startup, trigger at most one generic recovery turn because local
  background processes are session-bound. Point the Mate to persisted
  `interrupted` task metadata, but never replay it; the Mate still reconciles
  current authority and chooses every command.
- `AGENTOS_DISABLE_SUPERVISION_GUARD=true` is a break-glass operator override
  that disables both startup recovery and the turn-end reminder. Never set it
  automatically or use it merely to avoid following the supervision Skill.
- Keep this separate from the domain-neutral background command broker.
- Test observable Pi lifecycle behavior, not source strings.
