# Fleet AI Gateway

An optional, authenticated Fleet-local service for sharing a Captain-approved
pool of OpenAI Codex subscriptions across Agent Pods. It keeps sessions sticky,
routes with quota headroom, refreshes server-owned OAuth chains and streams the
provider's real response back to the native harness.

Direct per-Agent provider login remains the complete minimal and recovery path.
For a delegation-ready Fleet, install this service only when pooled
subscription capacity is worth the Captain-approved credential authority and
additional service lifecycle. The operator workflow lives in
`$agentos-ai-gateway`; the stable boundary lives in `ARCHITECTURE.md`.

The package derives its selection and credential-safety semantics from prior
MIT-licensed work by Robin Braemer and its raw proxy/session ideas from the
MIT-licensed `manaflow-ai/subrouter`. It does not capture transcripts, wrap
harness commands or silently change models/providers.

This is deliberately not a universal AgentOS proxy. Git, PostgreSQL,
Kubernetes, Herdr, registries and other provider tools retain their native
interfaces. Account login, refresh and routing-state changes use locked atomic
files and are observed by the running Bun service without a Caddy, Envoy or
other dynamic-route control plane. Provider adapters and selection semantics
remain reviewed source delivered through the normal image lifecycle.

The package, executable, Kubernetes resources, Service DNS, Secret, PVC path,
environment and client headers consistently use the `ai-gateway` identity.
