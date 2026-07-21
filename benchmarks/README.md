# Agent organization benchmark

This is a public, reproducible benchmark for systems that turn persistent
agents into an accountable organization. The portable core does not require
AgentOS, PostgreSQL, Kubernetes, Pi or any particular tracker. The
[AgentOS profile](./profiles/agentos/PROFILE.md) maps the neutral contracts to
AgentOS's released guarantees and authorities.

The benchmark asks one primary question:

> How many verified human outcomes does the organization deliver for the human
> attention it consumes?

An outcome counts only after effectiveness, safety and accountability pass.
The benchmark publishes the individual metrics and hard gates instead of one
weighted score.

## Current state

Version `0.1.0` defines the portable semantics, metric catalog, fixed scenario
rubrics, evidence and compact-result schemas, and first two scenarios. There are
no official AgentOS results yet. A result appears only
after every attempt in a declared run set has been preserved and independently
verified.

The [public benchmark epic](https://github.com/akua-dev/agentos/issues/14) is
the changing work-status authority. This table keeps the repository boundary
legible without duplicating issue checklists:

| Capability | State and tracking |
| --- | --- |
| Portable specification, structural schemas, AgentOS profile and two scenario definitions | Implemented here |
| Live Crewmate ship-loop proof | [Issue #10](https://github.com/akua-dev/agentos/issues/10) |
| Thin conformance, live and offline runner | [Issue #17](https://github.com/akua-dev/agentos/issues/17) |
| Metric catalog, published rubrics, compact result contract and verdict recomputation | [Issue #19](https://github.com/akua-dev/agentos/issues/19) |
| Optional allowlisted Pi session projection | Implemented in the AgentOS profile ([Issue #15](https://github.com/akua-dev/agentos/issues/15)) |
| First verified AgentOS baseline | [Issue #18](https://github.com/akua-dev/agentos/issues/18) |
| Non-AgentOS portability proof | [Issue #16](https://github.com/akua-dev/agentos/issues/16) |
| Before-and-after improvement proof with a held-out scenario | [Issue #20](https://github.com/akua-dev/agentos/issues/20) |

An original harness session remains unchanged and private in its native Agent
home. Only an allowlisted projection may enter shared or public evidence; see
the [session-adapter boundary](./SPEC.md#harness-session-adapters). AgentOS's
optional Pi-only implementation and output contract live in the
[AgentOS profile](./profiles/agentos/PROFILE.md#optional-session-evidence). The
portable validator and hard gates do not invoke or require it.

## Run it

1. Read [`SPEC.md`](./SPEC.md).
2. Select and freeze a versioned scenario before starting the subject:
   - [`quickstart-to-delivery`](./scenarios/quickstart-to-delivery/scenario.json)
   - [`interrupted-worker-recovery`](./scenarios/interrupted-worker-recovery/scenario.json)
3. Record the exact subject, model, harness, tool, environment and permission
   versions.
4. Operate the subject through its own public interfaces. Do not install an
   AgentOS compatibility layer around another system.
5. Produce one sanitized evidence JSON document for each attempt.
6. Validate it:

   ```console
   bun benchmarks/validate.ts evidence path/to/evidence.json
   ```

7. Create a compact result containing every declared attempt, rubric-bound
   qualitative verdicts, per-gate mechanical verdicts, aggregate observation
   counts and each immutable raw-bundle SHA-256.
8. Recompute its gates and aggregates against the published scenario and
   catalog:

   ```console
   bun benchmarks/validate.ts result path/to/result.json
   ```

Use `$agentos-evaluation` when running the benchmark from an AgentOS checkout or
live Fleet. Use `$agentos-improvement-review` only after the run bundle is
frozen.

## Modes

- **Conformance:** active, reproducible scenarios in a disposable environment;
  approved scenarios may inject failures.
- **Live:** observation of completed real work without fault injection.
- **Offline:** independent evaluation of an already frozen bundle.

## Contracts

- [`SPEC.md`](./SPEC.md) owns portable semantics, metrics, gates and reporting.
- [`scenario.schema.json`](./schemas/scenario.schema.json) owns scenario shape.
- [`catalog.json`](./metrics/catalog.json) defines every metric's unit and value
  type at catalog version `0.1.0`.
- [`evidence-bundle.schema.json`](./schemas/evidence-bundle.schema.json) owns one
  attempt's evidence shape.
- [`compact-result.schema.json`](./schemas/compact-result.schema.json) owns the
  public multi-attempt result shape. Its validator resolves IDs, preserves
  `unobserved` counts, and recomputes each mechanical gate independently.
- [`profiles/agentos/PROFILE.md`](./profiles/agentos/PROFILE.md) owns the
  AgentOS-specific evidence mapping.

Large raw bundles are release or benchmark artifacts rather than source files.
Compact official result manifests will live under `results/agentos/` only when
real results exist. A compact result has no composite gate or score: a failed or
unobserved gate remains visible for every attempt.
