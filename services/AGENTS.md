# AgentOS service boundary

This subtree contains optional long-running network processes. A service belongs
here only when a reviewed cross-Pod capability cannot be composed safely from
the native tools already carried by AgentOS.

- Keep every service optional unless `ARCHITECTURE.md` explicitly makes it part
  of the Fleet kernel.
- Own network lifecycle, durable service state, dependencies and behavior tests
  inside one `services/<name>/` package.
- Do not hide a capable native CLI behind a service, proxy PostgreSQL, queue
  prompts, duplicate Fleet coordination state, interpret model output or make
  Agent judgment.
- Authenticate every non-health interface. Default to no public Ingress and the
  smallest namespace/network reachability.
- Preserve native caller semantics: return actual upstream status and output;
  never turn a provider failure into apparent success.
- Do not turn one optional service into a mandatory Fleet-wide ingress, egress
  or service-mesh boundary. Every additional mediated protocol requires its
  own reviewed authority, failure and credential model.
- Never log or persist credentials, authorization headers, prompts, model
  responses or provider payloads unless a separately reviewed contract requires
  that exact data.
- Put operator judgment and conditional workflows in one Agent Skill. A service
  binary may expose narrow lifecycle or credential primitives only when no
  provider-native command owns them.

Reject a proposed service when a Skill plus native Git, `kubectl`, `psql`,
Herdr, Mise or provider CLI already solves the boundary.
