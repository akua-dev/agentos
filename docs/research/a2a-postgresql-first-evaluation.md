# PostgreSQL-first A2A delivery through agentgateway

Status: conditional go for implementation in #125; evaluated by #128 on
2026-08-01.

## Decision

AgentOS should expose A2A v1 as an authenticated, authorized, best-effort live
delivery edge through agentgateway. PostgreSQL remains the only Task,
Assignment, Inbox, receipt, hierarchy, and work-state authority.

The A2A adapter belongs in one ordinary, independently deployed Effect service
per Fleet or reviewed domain set. It does not run inside Pi or Codex, does not
share harness custody, does not become a Pod sidecar, does not declare Agent
Pods, and does not own durable A2A task state. Agentgateway routes to its
ordinary Kubernetes Service. The adapter validates a reference-only envelope,
authorizes it, observes the already-committed Inbox row, and attempts the live
wake. The existing PostgreSQL listener and Herdr wake path remains the recovery
path whether A2A succeeds or fails.

This is deliberately a transport integration, not a second coordination
system.

## Reviewed versions

| Component | Exact review baseline | Use in AgentOS |
| --- | --- | --- |
| Agentgateway | `1.4.1`, commit `163ea2146acb7b82082acea30ed691b29079095f` | Existing pinned routing and policy-enforcement point |
| A2A specification | `1.0.0`, commit `1736957` | Wire contract |
| A2A JavaScript SDK | `1.0.1`, commit `f5ca7d05945a69cbf3dcd357203d4ce99201494f` | Reference and external conformance only; not an AgentOS runtime dependency |
| Effect | `4.0.0-beta.102`, repository submodule commit `acee26944bc89ee554d7b9fadab7443f9edc28a9` | All AgentOS TypeScript orchestration and boundaries |

The reviewed [agentgateway release](https://github.com/agentgateway/agentgateway/releases/tag/v1.4.1)
publishes the exact binary and standalone chart already pinned in
`services/agentgateway/release.json`. The official [A2A v1 specification](https://github.com/a2aproject/A2A/blob/v1.0.0/docs/specification.md)
defines PascalCase JSON-RPC methods, `A2A-Version: 1.0`, the
`supportedInterfaces` Agent Card shape, and non-blocking `SendMessage`. The
official [JavaScript SDK release](https://github.com/a2aproject/a2a-js/releases/tag/v1.0.1)
is useful as an interoperability oracle, but its Promise-native server runtime
would add an unnecessary second orchestration model inside AgentOS.

## What agentgateway does and does not do

Agentgateway's [Kubernetes A2A guide](https://agentgateway.dev/docs/kubernetes/main/agent/a2a/)
separates the A2A Deployment and Service from routing. It recommends an
`AgentgatewayBackend` with `spec.a2a.host` and `port`, then an `HTTPRoute`; the
legacy alternative marks a Service with `appProtocol: kgateway.dev/a2a`.
Therefore agentgateway can route an existing AgentOS Service without owning or
declaring an Agent Pod.

Pinned 1.4.1 source review and the executable conformance test establish:

- `/.well-known/agent-card.json` is recognized and v1
  `supportedInterfaces[*].url` values are rewritten to the gateway address.
- Any JSON-RPC POST method is forwarded; the method name is inspected only for
  telemetry. `SendMessage` therefore routes without a 0.3 translation layer.
- External authorization can deny before the backend, pass a verified caller
  subject, and preserve the caller's projected bearer identity to the internal
  A2A boundary.
- The gateway does not create Pods, durable Tasks, Assignments, Inbox rows, or
  delivery receipts.

There is a material version gap. The current guide still demonstrates the old
`tasks/send` shape. Pinned source recognizes a v1 Agent Card, but its response
telemetry parser looks for `result.kind` and `result.status.state`. A2A v1 wraps
the Task as `result.task`, so 1.4.1 records the JSON-RPC outcome and method but
does not extract the v1 Task kind/state. AgentOS must emit its own bounded A2A
transport telemetry and must not use agentgateway's A2A Task-state fields as an
authority. Re-evaluate this gap before every agentgateway upgrade. The exact
[request/response implementation](https://github.com/agentgateway/agentgateway/blob/163ea2146acb7b82082acea30ed691b29079095f/crates/agentgateway/src/a2a/mod.rs)
and [v1 card tests](https://github.com/agentgateway/agentgateway/blob/163ea2146acb7b82082acea30ed691b29079095f/crates/agentgateway/src/a2a/tests.rs)
are the pinned evidence.

## Adapter placement

| Placement | Decision | Reason |
| --- | --- | --- |
| Harness process | Reject | Couples inter-Agent delivery to Pi/Codex session custody and violates the one-writer provider-native lifecycle boundary. |
| Per-Agent sidecar | Reject | Duplicates protocol/auth logic, prevents useful cold-target delivery, and couples cards and upgrades to every Agent Pod. |
| Separate ordinary Effect Service | Select | One narrow ingress can serve dynamic target paths and cards while PostgreSQL, Kubernetes, and Herdr retain their existing authorities. |
| kagent controller | Reject for core; reconsider only in #129 | kagent's Agent CRD declares the Agent, model, tools, and A2A skills, and its controller serves `/api/a2a/{namespace}/{agent}`. That replaces rather than adapts AgentOS ownership. |

The [kagent example](https://kagent.dev/docs/kagent/examples/a2a-agents)
demonstrates useful interoperability, but it declares a kagent `Agent` CRD and
manually embeds `a2aConfig.skills`; the controller then owns the shared A2A
endpoint. That is too opinionated for provider-native Pi/Codex sessions,
PostgreSQL-first coordination, and Herdr custody. Issue #129 may later test
kagent as an external A2A peer, never as AgentOS's Agent or Pod authority.

## Wire and authority contract

The authoritative sequence is:

1. The sending Agent commits the canonical Inbox row and, when applicable, its
   Task and active Assignment in PostgreSQL.
2. The client reads the committed row and compiles one deterministic A2A v1
   `SendMessage` request. No task brief or Inbox body crosses A2A.
3. Agentgateway authenticates the projected ServiceAccount bearer token through
   TokenReview and performs coarse caller/target route authorization.
4. The Effect A2A service decodes the closed body, strips caller-supplied trust
   metadata, and asks the policy boundary to authorize the verified caller,
   target, skill, direct hierarchy edge, and active Assignment when scoped.
5. The service verifies that the referenced Inbox row is committed and matches
   the verified identities, target, Task, Assignment, speech act, and skill.
6. The service attempts the targeted PostgreSQL notification/Herdr wake and
   returns a transport acknowledgement. It writes no alternate Task or Inbox
   state.
7. The target loads the Inbox body from PostgreSQL through its own database
   identity and calls the existing idempotent `agentos.receive_inbox()` before
   execution. Only canonical Task/Assignment functions may change work state.

The only A2A message part uses media type
`application/vnd.agentos.inbox-reference+json` and this closed data shape:

```json
{
  "kind": "agentos.inbox.reference",
  "version": 1,
  "inboxId": "<uuid>",
  "taskId": "<uuid-or-null>",
  "assignmentId": "<uuid-or-null>",
  "callerAgentId": "<uuid>",
  "targetAgentId": "<uuid>",
  "speechAct": "<released-inbox-kind>",
  "skillId": "<reviewed-skill>@v1",
  "subject": "<non-blank, at-most-240-characters>"
}
```

The request, message, context, and delivery Task IDs are deterministic from the
canonical UUIDs:

| A2A field | Derivation | Authority |
| --- | --- | --- |
| JSON-RPC request ID | `agentos:inbox:<inbox-id>` | Correlation only |
| Message ID | `agentos:inbox:<inbox-id>` | Idempotency/correlation only |
| Context ID | `agentos:task:<task-id>`, otherwise the Inbox Message ID | Correlation only |
| A2A Task ID | `agentos:delivery:<inbox-id>` | Live-delivery projection only |

No mapping table is permitted. A retry compiles the same bytes and repeats at
most a wake for the same Inbox UUID. The receiver claims the canonical row
before dispatch; a read or resolved row is not executed again. Task and
Assignment creation remain separately idempotent PostgreSQL transitions.

## Agent Cards and skill filtering

The public card exposes identity, the projected-bearer security scheme, and
`extendedAgentCard: true`, but no operational capability details. An
authenticated extended card is compiled per caller. A skill is advertised only
when its exact versioned ID is simultaneously:

- present in the immutable reviewed skill vocabulary;
- present in the target's reviewed profile;
- within the Captain-approved ceiling; and
- effectively allowed for the authenticated caller/target relationship.

An empty intersection returns a non-enumerating denial rather than an empty
operational card. Cards advertise only JSON-RPC v1 and the reference media type.
Streaming and push notifications remain `false`; artifacts are never emitted.
The A2A specification explicitly permits authenticated extended cards to vary
details by client authorization.

The service must emit gateway-external interface URLs before signing or
hashing a card. Agentgateway mutates interface URLs in transit; signing an
internal URL would invalidate a card signature. Authenticated cards use
`Cache-Control: private`, `Vary: Authorization`, and an authorization-profile
fingerprinted ETag. Do not cache one caller's filtered card for another caller.

## Operation semantics

| Operation/event | AgentOS behavior |
| --- | --- |
| `SendMessage` | Supported with `returnImmediately: true`; accepts only the committed reference envelope. |
| `GetTask` | In #125, derive the delivery projection from the canonical Inbox receipt; never expose body/history. |
| `ListTasks` | Not exposed initially; returning a cross-Agent inventory risks capability and work leakage. |
| `SendStreamingMessage` / `SubscribeToTask` | Unsupported and not advertised. PostgreSQL notifications already provide the internal live signal. |
| `CancelTask` | Does not cancel an AgentOS Task or Assignment. Request interruption stops only the live attempt; an explicit canonical cancellation remains a separately authorized PostgreSQL transition. |
| Push notification configuration | Unsupported and not advertised. |
| Artifacts | Unsupported. Artifacts remain canonical references loaded through the target's own authority. |

The official specification makes streaming capability-dependent and keeps a
Task lifecycle independent from any individual stream. That reinforces the
boundary: cancelling or losing the A2A request cannot be allowed to rewrite
the AgentOS Assignment.

## Failure and recovery matrix

| Failure | Client result | Canonical state | Recovery |
| --- | --- | --- | --- |
| TokenReview denial | Non-enumerating 401/403 | Unchanged | Sender corrects identity; committed row remains queryable. |
| OpenFGA caller/target/skill/edge denial | Non-enumerating 403 | Unchanged | No wake; caller returns through its hierarchy. |
| Missing/inactive scoped Assignment | 409 or typed JSON-RPC denial | Unchanged | Repair or create the canonical Assignment first. |
| Lateral sibling/Crewmate target | Denied | Unchanged | Return to the common ancestor, which may issue two direct-edge deliveries. |
| PostgreSQL unavailable before verification | 503 retryable | Already-committed rows remain durable | Listener catches up after recovery. |
| Target Pod or adapter unavailable | 503/timeout | Unchanged | PostgreSQL listener plus Herdr wake recovers the target. |
| Duplicate/retried `SendMessage` | Same deterministic delivery projection | No duplicate row or execution | At most repeats a targeted wake for the same Inbox ID. |
| Client disconnect/request cancellation | Live attempt interrupted | Inbox and Assignment unchanged | Durable listener path remains active. |
| A2A 200/Task `SUBMITTED` | Live edge accepted only | Does not set `read_at`, resolve Inbox, or complete Assignment | Target must load/receive through PostgreSQL. |
| agentgateway unavailable | No live attempt | Unchanged | Direct PostgreSQL listener remains sufficient; restore gateway for low-latency delivery. |

## Hierarchy routing

Direct parent-child delivery is the only A2A Agent edge. A cross-domain request
returns to the known common ancestor, which decides whether to create separate
direct-edge deliveries. Lateral Second-Mate-to-Second-Mate and
Crewmate-to-Crewmate delivery is denied even if two ServiceAccounts share a
namespace or can reach the Service. PostgreSQL's
`inbox_enforce_hierarchy_edge` trigger remains the final invariant for every
Agent-authored Inbox row.

## Executable evidence and overhead

`services/agentgateway/tests/a2a-v1.effect.test.ts` runs entirely through Effect
services and narrow typed Bun boundaries. When
`AGENTOS_AGENTGATEWAY_BIN` is set, it verifies the release checksum, version,
and Git revision; starts the exact binary; proves unauthenticated denial,
external authorization, caller-subject propagation, v1 Agent Card rewriting,
and v1 reference delivery; then benchmarks the same loopback backend directly
and through agentgateway plus external authorization.

Measured on 2026-08-01 on Darwin arm64 with the pinned release binary, five
warm-up pairs, and 50 sequential measured requests per path:

| Path | p50 | p95 |
| --- | ---: | ---: |
| Direct loopback backend | 0.138 ms | 0.293 ms |
| agentgateway + external authorization | 0.349 ms | 0.735 ms |
| Added | 0.211 ms | 0.442 ms |

This is a local protocol-spike measurement, not a production latency SLO. Issue
#130 must repeat it in the disposable Kubernetes Fleet with TokenReview,
OpenFGA, PostgreSQL, telemetry export, network hops, retries, target outages,
and concurrent load.

## Implementation gate for #125

Proceed only with all of these constraints:

1. Build an ordinary Effect A2A service and Effect entrypoint; no Promise
   orchestration, ambient environment reads, native timers, throws, type
   assertions, or nested runtimes.
2. Add the service, `AgentgatewayBackend`, policy, and `HTTPRoute` through the
   existing Kustomize source of truth. Agentgateway routes the Service and owns
   no Agent workload.
3. Use the kubelet-rotated projected caller token for TokenReview. Extend the
   pinned OpenFGA model with explicit caller, target, versioned skill,
   direct-edge, and active-Assignment checks; reject caller-supplied decision
   metadata.
4. Load and verify the committed Inbox row before live delivery. The target
   loads content with its own PostgreSQL identity and records receipt through
   `agentos.receive_inbox()`.
5. Keep A2A identifiers deterministic and non-authoritative. Do not add an A2A
   Task store, transcript, prompt queue, or mapping table.
6. Emit bounded AgentOS telemetry for method, outcome, retry, timeout, target,
   authorized skill ID, and stable correlation IDs. Never emit the subject,
   body, credentials, Agent Card descriptions, or provider/session content.
7. Fail readiness closed when TokenReview, OpenFGA, or PostgreSQL verification
   is unavailable, while leaving the durable listener recovery path intact.
8. Keep kagent outside the core. Run #129 only as optional peer
   interoperability after #125 and #130 pass.

## Acceptance evidence

- Routing without Pod ownership: proved by the pinned binary and supported by
  the separate-backend agentgateway model.
- TokenReview/OpenFGA contract: the closed compiler requires authenticated
  identity and allowed caller, target, skill, hierarchy, and scoped Assignment;
  live Kubernetes enforcement is required in #125/#130.
- Agent Card filtering: Effect tests prove the reviewed/profile/ceiling/effective
  intersection and empty-intersection denial.
- Retry/idempotency: Effect tests prove deterministic IDs and that the A2A
  retry plan cannot create a Task, Assignment, Inbox row, execution, or report.
  The existing full repository check also exercises atomic idempotent Task
  acceptance, Inbox receipt, direct-edge routing, and commit-only
  notifications. Issue #130 repeats the integrated races in Kubernetes.
- Canonical-state separation: Effect tests prove accepted, failed, timed-out,
  and cancelled transport outcomes emit no Inbox or Assignment mutation.
- Outage recovery: the Effect failure-injection test covers caller, gateway,
  authorizer, target Pod, adapter, stream, and PostgreSQL failures and preserves
  the PostgreSQL-listener/Herdr recovery plan for every committed reference.
  Destructive Kubernetes evidence remains in #130.
- Placement and versions: selected and pinned above.
- Measured overhead: executable result recorded above and reproducible through
  the Effect conformance test.
