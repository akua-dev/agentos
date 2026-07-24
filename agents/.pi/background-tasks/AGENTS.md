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
- Default listing to every running command and no terminal history. Permit
  explicit state selection with a bounded terminal page and stable older-page
  cursor. An `all` view must never hide a running wait behind its terminal
  page limit.
- Persist sanitized lifecycle metadata through Pi's native custom session
  entries. Never persist command output there. On session restoration, treat a
  previously running or non-explicitly cancelled task as `interrupted`; expose
  it for reconciliation without emitting a completion wake or replaying its
  command. Checkpoint running metadata onto Pi's selected branch after session
  tree navigation so later restoration follows native branch semantics.
- A natural completion wakes Pi with task ID, command, description, exit or
  signal, and duration only. Never inject command output into the wake.
- When a caller supplies a literal readiness marker, report a successful start
  only after bounded observation of that marker on stdout or stderr. Early exit
  or readiness timeout is a failed start; never infer readiness from command
  identity or domain-specific output here.
- Treat a broker deadline as failure. Completion still wakes Pi for judgment;
  the caller reconciles current authority before deciding whether to re-arm.
- Treat completion as a signal, not authority. Query PostgreSQL, Herdr or
  Kubernetes again before acting on their state.
- A process belongs to this Pi runtime. Session shutdown terminates its process
  group. Its session-scoped metadata may survive so a later runtime can
  reconcile and deliberately re-arm a still-needed wait; never claim process
  replay across runtime or Pod failure.
- Pass credentials only through inherited environment or native config. Never
  put them in command strings or task metadata.
- Preserve exactly-once terminal transitions, bounded model output, capped
  file-backed logs and bounded TERM-to-KILL process-group cleanup.
- Never add a domain adapter, AgentOS wrapper, Bash script, tmux fallback,
  daemon, controller, shell `&`, or polling loop here.
- Add behavior through a failing test first and keep role-local extension
  entry points free of policy or duplicated implementation.
