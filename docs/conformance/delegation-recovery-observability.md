# Delegation and recovery observability conformance

AgentOS traces every durable delegation/runtime operation from its topology
decision to a terminal outcome without recording agent reasoning, content,
credentials, or rendered Kubernetes YAML. Telemetry is evidence only: Collector
or backend failure cannot change reconciliation, retry, readiness, fallback, or
serving behavior.

## Span model

One protected root span, `agentos.resilience.operation`, owns the durable
operation correlation. Ordered child spans are named
`agentos.resilience.<phase>` and use the closed phases `topology_decision`,
`workload_plan`, `render`, `apply`, `capacity`, `placement`, `readiness`,
`provider`, `listener`, `protocol`, `session`, `reconciliation`, and `outcome`.
An unavailable boundary emits explicit `unobserved` evidence; absence is never
interpreted as success.

The topology plan contributes bounded action/reason signals only. The workload
compiler contributes spec and overlay digests. The renderer or reviewed runtime
journal contributes a render digest. No component may attach charters, prompts,
reasoning, raw manifests, Secrets, provider identities, transcript text, or
memory content.

## Cardinality and protection

Metrics expose only the closed source, phase, evidence, outcome, cause,
recovery, attempt, topology action/reason, runtime action, workload profile/spec
version, journal phase, and protocol attributes. Agent, Assignment, proposal,
operation, Pod, PVC, session, and protocol IDs and all spec/overlay/render
digests are permitted only on protected spans or equally protected diagnostic
logs.

The emitted metrics are `agentos.resilience.observations`,
`agentos.resilience.operations`, and
`agentos.resilience.operation.duration`. Export and diagnostic failures are
caught and discarded at the telemetry boundary after best-effort span cleanup.

## Native evidence projections

| Boundary | Accepted source | Evidence |
| --- | --- | --- |
| Topology | compiled First Mate topology plan | bounded expand/modify/shrink action and reviewed reasons |
| Workload plan | compiled `AgentWorkloadSpec` summary | profile, version, spec digest, overlay digest |
| Runtime | durable SQL runtime journal | action, exact journal phase, attempt, reviewed render digest, bounded cause/recovery |
| Readiness | semantic health diagnostic decoded by Effect Schema | bounded status and cause class; raw reason code is not emitted |
| Session | native session availability contract | available, resumed, unavailable, or explicitly unobserved |
| Protocol | released ACP/A2A conformance observation | bounded outcome, cause, fallback, and protected protocol correlation |

Every external input is decoded with a closed Effect Schema before projection.
Contradictory journal states are rejected rather than silently normalized.

## Operator contract

The packaged `agentos-observability` skill defines backend-neutral dashboards,
alerts, and linked runbooks. It covers invalid/conflicting workload plans,
render/apply boundaries, capacity/placement, semantic readiness, provider and
listener failures, protocol fallback, native-session recovery, policy denial,
reconciliation loops, retry exhaustion, and missing evidence. Operators locate
individual workloads through protected traces; metric alerts never group by
dynamic identity or digest fields.
