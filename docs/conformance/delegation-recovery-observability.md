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
journal contributes a render digest. Compiler-originated custody persists all
three digests through the typed workload-operation Functions, so telemetry and
repair evidence cannot join a changed spec to an old operation merely because
the render is equivalent. No component may attach charters, prompts,
reasoning, raw manifests, Secrets, provider identities, transcript text, or
memory content.

## Cardinality and protection

Metrics expose only the closed source, phase, evidence, outcome, cause,
failure class, recovery, attempt, topology action/reason, runtime action,
workload profile/spec version, journal phase, and protocol attributes. Agent,
Assignment, proposal,
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
| Assignment execution | durable SQL execution epoch | bounded failure/attempt, visibly blocked exhaustion, and resume/reassign/stop outcome |

Every external input is decoded with a closed Effect Schema before projection.
Contradictory journal states are rejected rather than silently normalized.

## Typed workload recovery proof

The opt-in disposable-cluster suite compiles persistent-Mate and interactive-
Crewmate plans from ordinary native Kustomize resources, decodes the rendered
objects, and exercises server-side dry-run, diff, apply, admission and
namespace-scoped RBAC. It injects a failing readiness path, observes rollout
failure, reapplies the exact plan, deletes only the stale non-ready Pod required
by StatefulSet `OrderedReady` repair, and proves both the retained PVC UID and
native session marker survive two Pod replacements. It then deletes the child
plan, verifies the PVC remains, removes every disposable namespace and policy,
and records only bounded digests and booleans.

The in-memory PostgreSQL companion drives the same typed operation through
render, apply, rollout, Herdr-launch and locator-update interruption codes. It
proves exact retry, rejects a changed spec with an identical render, preserves
Agent/Task/Assignment counts and joins the one operation ID and three digests
only on protected trace attributes. Metrics receive none of those identities
or digests.

The same disposable-workload test now creates a fresh PostgreSQL execution
authority while the interactive Crewmate Pod is live. It exhausts a transient
provider epoch, resumes the exact Agent/Assignment/runtime/native-session tuple,
and proves the Pod UID, PVC UID, worktree marker, native-session marker, and
single-writer replica count did not change. A held-out authentication case is
denied without `authority:` evidence, and a held-out capacity case is denied
until a distinct matching runtime operation reaches a verified ready phase.
The deterministic companion runs without a cluster in CI; the opt-in live gate
runs this transition inside the same explicitly approved local Kind lifecycle
as the admission, RBAC, readiness-failure, repair, Pod-replacement, retained-PVC,
and cleanup proof. Workload and protocol disposable suites accept the shared
`kind-agentos-resilience-*` context so #127, #130, and retry recovery can be run
against one disposable cluster without contacting a production endpoint.

## Operator contract

The packaged `agentos-observability` skill defines backend-neutral dashboards,
alerts, and linked runbooks. It covers invalid/conflicting workload plans,
render/apply boundaries, capacity/placement, semantic readiness, provider and
listener failures, protocol fallback, native-session recovery, policy denial,
reconciliation loops, retry exhaustion, and missing evidence. Operators locate
individual workloads through protected traces; metric alerts never group by
dynamic identity or digest fields.
