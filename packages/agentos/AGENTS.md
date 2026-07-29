# Pi-native AgentOS package boundary

This is AgentOS's one public npm package. Its root export is an inert functional
API over Pi's public `ExtensionAPI`; its Pi manifest declares the released
extension and resources. Pi remains the extension host and lifecycle authority.

- Importing the root package must not write files, spawn processes, start
  timers, connect to external systems or register process-global state.
- Every registration receives `pi` explicitly and keeps mutable state inside
  that registration call. Export pure defaults, plain structural values,
  handler factories and explicit registration functions.
- Expose exactly one Pi extension entrypoint. Keep role setup modules,
  instructions, Mise, Kubernetes and Crewmate resources outside extension
  discovery.
- Select exactly one persistent role from `AGENTOS_AGENT_ROLE`. Missing or
  unknown roles fail before any AgentOS registration.
- The released extension imports only the public `@akua-dev/agentos` root.
  Resolve every fallible static input and known-name collision before handlers,
  tools or commands attach.
- Never infer Assignment, database, Kubernetes, Git, Herdr or provider events
  from a Pi event. An extension may prompt the model to inspect a native
  authority; it must not claim that authority changed.
- Do not perform external mutation during module import or registration.
  Session-bound processes may start only through an explicit runtime tool call
  and must retain their bounded cleanup contract.
- Declare known tool, command, Skill, custom-message and persisted-entry names
  before registration. Reject collisions instead of relying on Pi load order.
- Operational role identity lives in explicit injected resources. Files named
  `AGENTS.md` in this package govern contributors only and are never a second
  operational identity source.
- The Pi manifest owns only Pi resources. Mise and Kubernetes files remain
  native pre-start assets; loading this package never applies or verifies
  external state.
- Shared Skills live under the manifest's `skills/` root. Role-specific Skills
  are supplied only by the selected role setup.
- Compile the public API and role setup to Node-compatible ESM with declarations.
- Package and real-Pi tests must exercise the clean installed artifact as well
  as the source checkout. Test rendered native resources structurally.

Keep workflow judgment in the released Skills and deterministic mechanics in
TypeScript, SQL or native declarative assets owned by their component.
