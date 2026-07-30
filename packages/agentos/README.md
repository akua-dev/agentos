# `@akua-dev/agentos`

`@akua-dev/agentos` is the released AgentOS distribution. It is an ordinary Pi
package and an inert public TypeScript API. Importing the package registers
nothing. Explicitly selecting it in Pi loads exactly one extension entrypoint
and one shared Skill root. The entrypoint selects one First- or Second-Mate role
setup from the deployment's explicit `AGENTOS_AGENT_ROLE`.

The native package manifest preloads shared Skills before `session_start`.
Role-only Skills are added through Pi resource discovery afterward, so the
bounded startup turn may require only a Skill that Pi already exposes in its
effective pre-session catalog.

The public root exports plain registration contracts, preflight helpers,
instruction and resource helpers, bounded startup behavior, and factories for
released Pi behavior. Every registration accepts Pi's `ExtensionAPI`
explicitly. Ecosystem packages remain free to use any ordinary Pi API beside
these helpers.

Operational instructions, role-specific Skills, Mise files, Kubernetes
overlays and Crewmate assets are normal package resources. Loading the package
into Pi activates only Pi behavior and resources; it does not apply native
runtime assets or mutate any external authority.

Persistent deployments select this package twice: native Pi settings choose
its extension and Skills, while the workload sets `AGENTOS_DISTRIBUTION_ROOT`
and starts from the exact role directory that owns its Mise and Kubernetes
selection. A custom distribution can preserve this layout while replacing any
or all role resources.

An organization replacement may depend on this package for its root exports
without activating the released entrypoint. Pi loads only packages explicitly
selected in its settings.

| `@akua-dev/agentos` | Pi AI API | Pi coding-agent API |
| --- | --- | --- |
| `0.1.0` | `0.81.1` | `0.81.1` |

See the repository's `CUSTOMIZATION.md` and released
`agentos-customization` Skill for the trusted-package workflow.

## OpenTelemetry

The package exports the versioned privacy-safe AI telemetry contract, a
fail-open JS runtime, and Pi observability registration. The standalone
`extensions/agentos-observability.ts` entrypoint is intentionally loadable with
`pi -ne -e` so an operator can keep telemetry while disabling ordinary
extension discovery for a controlled comparison.

Fleet workloads use the standard `OTEL_*` environment surface. Crewmate home
preparation maps those variables into the pinned Codex CLI's native `[otel]`
configuration, preserves unrelated Codex settings, and forces
`log_user_prompt = false`. Collector/backend failure does not affect inference
readiness.

Use the released `agentos-observability` Skill for trace interpretation,
extension/session control trials, dashboards, alerts, and incident runbooks.
The canonical field, privacy, propagation, retention, and compatibility
contract remains in
[`ARCHITECTURE.md`](../../ARCHITECTURE.md#ai-telemetry-contract-v1).
