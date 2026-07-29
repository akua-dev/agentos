# `@agentos/default`

`@agentos/default` is the released AgentOS distribution. It is an ordinary Pi
package with exactly one discovered extension entrypoint and one shared Skill
root. The entrypoint selects one ordinary First- or Second-Mate composition
from the deployment's explicit `AGENTOS_AGENT_ROLE`.

The package composes only public `@agentos/pi` registrations. Its operational
instructions, role-specific Skills, Mise files, Kubernetes overlays and
Crewmate assets are normal package resources. Loading it into Pi activates only
Pi behavior and resources; it does not apply those native runtime assets or
mutate any external authority.

Persistent deployments select this package twice: native Pi settings choose
its extension and Skills, while the workload sets `AGENTOS_DISTRIBUTION_ROOT`
and starts from the exact role directory that owns its Mise and Kubernetes
selection. A custom distribution can preserve this layout while replacing any
or all role resources.

The initial compatibility matrix is:

| `@agentos/default` | `@agentos/pi` | Pi coding agent |
| --- | --- | --- |
| `0.1.x` | `0.1.x` | `0.81.1` |
