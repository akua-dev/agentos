# Default AgentOS distribution boundary

This package is the released, replaceable AgentOS distribution for Pi. It is
an ordinary Pi package, not a privileged loader.

- Expose exactly one Pi extension entrypoint. Keep role composition modules,
  instructions, Mise, Kubernetes and Crewmate resources outside extension
  discovery.
- Select exactly one persistent role from `AGENTOS_AGENT_ROLE`. Missing or
  unknown roles fail before any AgentOS registration.
- Compose released behavior only through public `@agentos/pi` exports.
  Fallible resource and collision preflight completes before handlers, tools
  or commands attach.
- Operational role identity lives in explicit injected resources. Files named
  `AGENTS.md` in this package govern contributors only and are never a second
  operational identity source.
- The Pi manifest owns only Pi resources. Mise and Kubernetes files remain
  native pre-start assets; loading this package never applies or verifies
  external state.
- Shared Skills live under the manifest's `skills/` root. Role-specific Skills
  are supplied only by the selected role's resource composition.
- Package and real-Pi tests must exercise the clean installed artifact as well
  as the source checkout. Test rendered native resources structurally.

Keep workflow judgment in the released Skills and deterministic mechanics in
TypeScript, SQL or native declarative assets owned by their component.
