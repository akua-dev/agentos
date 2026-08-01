# Effect architecture

AgentOS requires Effect as the composition model for every repository-owned
TypeScript or TSX path that performs work. Pure calculations and presentational
TS/TSX may remain plain TypeScript. Framework callbacks, executable entrypoints
and third-party APIs are one-way adapters: they enter one managed Effect runtime
and do not leak their ambient runtime or domain orchestration back across the
boundary. Inventoried legacy is finite migration debt, never an alternative
architecture or precedent for new code.

The repository [`effect-ts` Skill](../.agents/skills/effect-ts/SKILL.md) is the
coding standard. This document owns migration boundaries, dependency direction
and enforcement. The two must agree; when an Effect API is unclear, consult the
Skill guides and then the pinned `.repos/effect` source rather than guessing.

## Dependency set

All direct `effect` and `@effect/*` dependencies use the exact release declared
in [`policy.json`](../tooling/effect-migration/policy.json). The initial aligned
set is:

| Concern | Package |
| --- | --- |
| Core, Schema, Config, Stream and SQL interfaces | `effect` |
| Bun filesystem, process and runtime Layers | `@effect/platform-bun` |
| Browser HTTP platform | `@effect/platform-browser` |
| PostgreSQL driver Layer | `@effect/sql-pg` |
| Effect-to-OpenTelemetry wiring | `@effect/opentelemetry` |
| Layer-aware tests and virtual time | `@effect/vitest` |

The gate scans every workspace manifest. Ranges, workspace-relative versions,
mixed betas and undeclared `@effect/*` packages fail. `bun.lock` remains the
install authority and CI installs it frozen. A new Effect package must be
needed by a real slice, pinned to the same release and added to the policy.

## Dependency direction

Domain workflows depend on narrow services and owned Schema contracts. Live
Layers depend on Effect platform or provider adapters. Only the executable or
framework edge provides the full live Layer and runs the program.

```text
entry/framework adapter -> live Layer composition -> domain Effect workflow
                                               -> owned Schema and tagged errors
test adapter            -> deterministic Layers -> the same domain workflow
```

The released shared foundation lives in `packages/agentos/src/shared`:

| Module | Authority |
| --- | --- |
| `contracts.ts` | Versioned wire Schemas and safe boundary decoders |
| `errors.ts` | Tagged failures and the stable public failure envelope |
| `services.ts` | Identifier and diagnostic services with live and deterministic test Layers |
| `legacy.ts` | Temporary, explicitly inventoried compatibility debt scheduled for removal; never a pattern for new code |

Instructions, registration preflight, resources, role configuration, startup,
and semantic readiness expose composable `*Effect` programs. Remaining plain
or Promise-returning legacy exports must be replaced as their inventory slices
land; no new compatibility adapter is allowed. Readiness programs require
`FileSystem`, `Path`, and `AgentOSIdentifier`; the executable edge supplies Bun
live Layers once.

Do not call `runPromise` inside a service, hide dependencies in globals, wrap
native Kubernetes/Git/SQL authority with shadow state, or provide a live Layer
deep inside business logic. Kubernetes remains live-workload truth,
PostgreSQL remains coordination truth, and raw SQL migrations remain the
database contract.

## Standard patterns

- Reusable operations use `Effect.fn`; `Effect.gen` expresses local workflows.
- External and persisted values decode with Effect Schema. Reusable owned
  models prefer named Schema classes; small local row/response shapes may use
  `Schema.Struct`.
- Expected failures use precise `Schema.TaggedErrorClass` values. Defects stay
  defects, interruption stays interruption, and public adapters map only known
  errors to stable safe envelopes.
- Environment values use Effect Config. Credentials use redacted config or a
  dedicated credential service and never become log/span attributes.
- Files, subprocesses, listeners, streams, servers, leases and database
  connections are acquired in scopes with finalizers. Cancellation must reach
  the underlying operation.
- Retries surround only classified transient operations. They are bounded,
  idempotency-aware and observable; backoff and jitter are selected per
  provider rather than applied to a whole workflow.
- Functions and material operations receive stable names/spans. Logs use
  bounded identifiers and reason codes, while metrics avoid unbounded Agent,
  Task, payload or credential labels.
- Production dependencies are services with live Layers. Tests provide
  deterministic Layers for clock, randomness, filesystem, SQL, HTTP, process,
  Kubernetes and authorization boundaries.

Compile-checked implementations live under
[`tooling/effect-migration/references/`](../tooling/effect-migration/references/):

| Boundary | Reference |
| --- | --- |
| Service, Layer, Schema, tagged error and Config | [`foundation.ts`](../tooling/effect-migration/references/foundation.ts) |
| Filesystem and JSON contract | [`filesystem.ts`](../tooling/effect-migration/references/filesystem.ts) |
| HTTP, status handling, bounded retry and tracing | [`http.ts`](../tooling/effect-migration/references/http.ts) |
| Scoped child process and streamed output | [`process.ts`](../tooling/effect-migration/references/process.ts) |
| Effect SQL, typed rows and transaction | [`database.ts`](../tooling/effect-migration/references/database.ts) |
| Schema-decoded stream | [`stream.ts`](../tooling/effect-migration/references/stream.ts) |
| `@effect/vitest` and deterministic test Layer | [`testing.test.ts`](../tooling/effect-migration/references/testing.test.ts) |

These are boundary shapes, not parallel product abstractions. A migration
should reuse the smallest relevant pattern and keep its own domain names.

The typed Agent workload boundary follows the same split. The released
`AgentWorkloadSpecV1Schema` decodes a closed, credential-reference-only input,
and `compileAgentWorkloadSpec` is a pure Effect program that validates and
normalizes that input into deterministic Kustomize files, digests and a safe
review summary. Filesystem path canonicalization, file writes and native
Kubernetes commands stay in the runtime operation layer; the compiler cannot
apply or observe cluster state.

Workload-profile resolution is a separate pure Effect boundary. It decodes an
exact immutable profile ID, already-resolved dispatch requirements and optional
domain defaults, then proves only mechanical eligibility and #77 bounds.
Profile selection remains Assignment dispatch judgment. Released profiles own
exact Kustomize base references and definition digests; future profiles remain
visible for compatibility checks but fail closed at the compiler boundary.

The provider authorization HTTP boundary follows the same rule without a
Promise bridge. `services/egress-authz` registers an Effect Platform router,
composes scoped PostgreSQL, Kubernetes HTTP, OpenFGA, cryptography, identity and
PDP Layers, and launches them through one reviewed Bun entry call. Header/body
limits, concurrency admission, dependency timeouts, readiness and cancellation
all remain in the Effect program. Its tests are `@effect/vitest` programs with
deterministic services and TestClock.

## Inventory and progressive enforcement

[`inventory.json`](../tooling/effect-migration/inventory.json) assigns every
AgentOS-owned TS/TSX path to one migration issue with runtime, package, I/O
surfaces and prerequisites. Rules are evaluated in order, so a narrow rule
belongs before a broad package fallback. The gate rejects an empty rule or any
unassigned path. Generated and vendored trees are excluded by explicit
directory or path rules in `policy.json`; adding a new exclusion requires the
same review as the inventory because ignored source cannot be migrated.

Each slice has one status:

- `planned`: inventoried legacy removal work; strict rules are pending only so
  the repository stays buildable while that finite slice is migrated.
- `migrated`: effectful code whose strict rules and conformance tests apply.
- `pure`: reviewed code with no runtime effect; keep it free of unnecessary
  Effect wrapping and reclassify it if I/O is introduced.
- `runtime-boundary`: a deliberately narrow framework/executable adapter. It
  is enforced like migrated code, with exact exceptions for required escapes.

The Oxc AST gate rejects these patterns in enforced paths: async
functions, constructed Promises, thrown failures, ambient environment reads,
unreviewed Effect runtime execution, raw HTTP/filesystem/process calls, unsafe
type assertions, untyped JSON parsing and native timers. Enforcement rolls out
in finite slices so untouched legacy remains buildable; the required end state
is zero legacy effectful TypeScript, and completed paths cannot regress.

[`exceptions.json`](../tooling/effect-migration/exceptions.json) is the only
escape registry. Each record names one file, one rule, an exact source match,
a positive occurrence ceiling and a substantive reason. The checker rejects
stale, over-limit or non-enforced exceptions. Pure code is represented by
inventory status rather than by suppressing rules.

## Migrating a slice

1. Characterize current wire, CLI, persisted, cancellation and error behavior.
2. Define owned Schemas, tagged errors and service interfaces before live
   adapters.
3. Build deterministic test Layers and migrate effectful tests to
   `@effect/vitest`; leave truly pure tests simple.
4. Move runtime I/O behind scoped platform/provider Layers, compose them at the
   edge, and preserve native authority boundaries.
5. Change the narrow inventory rule from `planned` to `migrated` and resolve
   every gate finding without broad suppression.
6. Run the slice conformance suite, `bun run effect:check`, `bun run
   effect:test`, build/typecheck and the full repository check. Use disposable
   Kubernetes and provider fixtures when the slice changes those boundaries.

Final repository-wide enforcement belongs to issue #103 only after all earlier
slices are migrated and their compatibility evidence is retained.
