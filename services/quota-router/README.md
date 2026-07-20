# Fleet quota router

An optional, authenticated Fleet-local service for sharing a Captain-approved
pool of OpenAI Codex subscriptions across Agent Pods. It keeps sessions sticky,
routes with quota headroom, refreshes server-owned OAuth chains and streams the
provider's real response back to the native harness.

Direct per-Agent provider login remains a complete AgentOS setup. Install this
service only when pooled subscription capacity is worth the additional
credential authority and operational surface. The operator workflow lives in
`$agentos-quota-router`; the stable boundary lives in `ARCHITECTURE.md`.

The package derives its selection and credential-safety semantics from Robin
Braemer's MIT-licensed `pi-quota-router` and its raw proxy/session ideas from the
MIT-licensed `manaflow-ai/subrouter`. It does not capture transcripts, wrap
harness commands or silently change models/providers.
