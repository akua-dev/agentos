# Pi background task implementation boundary

This module is the shared Pi command broker for persistent First and Second
Mates. Its public shape intentionally stays close to Grok's background command
contract: start a described shell command, receive a stable task ID, pull
bounded output when useful, list it, or kill it.

- Keep the broker domain-neutral. PostgreSQL, Herdr and Kubernetes remain
  native commands selected by Agent guidance, never adapters in this module.
- Permit several independent background commands at once. The supervising Mate
  chooses and deduplicates the useful authority/target/predicate set; this
  broker must not impose a single-wait topology or encode Fleet policy.
- A natural completion wakes Pi with task ID, command, description, exit or
  signal, and duration only. Never inject command output into the wake.
- Treat completion as a signal, not authority. Query PostgreSQL, Herdr or
  Kubernetes again before acting on their state.
- A task belongs to this Pi runtime. Session shutdown terminates its process
  group and a later session deliberately re-arms any still-needed wait from
  durable state; never claim process replay across runtime or Pod failure.
- Pass credentials only through inherited environment or native config. Never
  put them in command strings or task metadata.
- Preserve exactly-once terminal transitions, bounded model output, capped
  file-backed logs and bounded TERM-to-KILL process-group cleanup.
- Never add a domain adapter, AgentOS wrapper, Bash script, tmux fallback,
  daemon, controller, shell `&`, or polling loop here.
- Add behavior through a failing test first and keep role-local extension
  entry points free of policy or duplicated implementation.
