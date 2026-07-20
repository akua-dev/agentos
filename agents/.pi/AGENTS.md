# Shared Pi extension boundary

This directory contains shared Pi mechanics exposed through the role-local
extension entry points under First and Second Mate. A Pi extension may provide
small deterministic lifecycle hooks or generic tools; Agent guidance owns how
those capabilities are used.

## Qualify the implementation location

Use the first boundary that owns the behavior:

1. If a Mate can use an existing native CLI directly, document the workflow in
   one Skill.
2. If behavior is durable coordination, authorization or data integrity,
   implement it in the owning PostgreSQL migration, function, RLS policy,
   Kubernetes resource or other authority.
3. If an executable is useful independently of Pi, qualify it under `clis/`.
4. If it must run independently for a long time, treat it as a service that
   requires explicit architecture review.
5. Only use a Pi extension for a small deterministic capability that exists
   specifically at the Pi tool or session lifecycle boundary.

Inside an extension, keep the event path narrow:

```text
Pi event
  -> observe generic evidence
  -> perform a deterministic mechanical reaction
  -> inject the smallest useful pointer or reminder
  -> let the Mate interpret authoritative state and decide what to do
```

For example, owning a session-bound child process and reporting its completion
is extension work. Selecting `pg-listen`, a Kubernetes wait or an SQL query is
Mate judgment taught by a Skill. Recognizing the `[agentos-supervision]` marker
and issuing one bounded reminder is extension work; deciding whether that wait
is correct remains Mate judgment. PostgreSQL, not Pi, enforces Task authority.

- Keep loaded extension code compatible with Pi's Node runtime. Do not import
  Bun runtime APIs into an extension module merely because Bun runs repository
  tooling and tests.
- Import the public Pi extension SDK directly. Do not create a local Pi API
  facade or duplicate SDK types.
- Keep domain policy in the closest `AGENTS.md` or one shared Skill. An
  extension must not choose PostgreSQL queries, Kubernetes resources, Herdr
  targets, harnesses, models, work assignments or recovery strategy for a Mate.
- Never statically launch a background command, encode a watcher topology,
  append shell `&`, add a polling loop, or hide a daemon, controller or CLI
  wrapper in an extension. The Mate chooses native commands through the generic
  capability documented by its Skills.
- Treat extension memory and child processes as session-bound. PostgreSQL,
  Kubernetes, Herdr, PVCs and Git remain the durable authorities described by
  AgentOS architecture; do not create shadow state here.
- A lifecycle hook may request a bounded follow-up for a concrete completion or
  recovery backstop. Prevent recursive or unendable follow-up loops, keep
  injected context minimal, and leave semantic verification to the Agent.
- Never place credentials in command strings, process arguments, extension
  messages, task metadata or logs. Use approved inherited environment or native
  configuration.
- Test observable Pi events, tool results, process ownership and real role
  discovery. Do not test that implementation files merely contain selected
  strings.

Keep role-local files as thin availability entry points. Shared implementation
and policy-neutral tests belong here; a nearer `AGENTS.md` adds the contract for
its extension without weakening this boundary.
