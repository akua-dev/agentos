# AgentOS Pi composition-library boundary

This package is an inert functional library over Pi's public `ExtensionAPI`.
Pi remains the extension host and lifecycle authority.

- Every registration receives `pi` explicitly and keeps mutable state inside
  that registration call.
- Export pure defaults, plain structural values, handler factories and
  explicit registration functions. Do not add a service locator, registry,
  singleton, internal event bus or implicit package discovery.
- Resolve and validate every fallible static input before attaching handlers,
  tools or commands.
- Never infer Assignment, database, Kubernetes, Git, Herdr or provider events
  from a Pi event. An extension may prompt the model to inspect a native
  authority; it must not claim that authority changed.
- Do not perform external mutation during module import or registration.
  Session-bound processes may start only through an explicit runtime tool call
  and must retain their existing bounded cleanup contract.
- Declare known tool, command, Skill, custom-message and persisted-entry names
  before composed registration. Reject collisions instead of relying on Pi
  load order.
- Compile the public package to Node-compatible ESM with declarations and test
  external consumers only through documented exports.

Tests exercise public behavior, real Pi lifecycle interfaces where useful, and
module/artifact isolation. They never prove contracts by searching source text.
