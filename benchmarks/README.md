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

## Published proof

Version `0.1.0` defines the portable semantics, metric catalog, fixed scenario
rubrics, evidence and compact-result schemas, and first two scenarios. These
published results exercise the full contract rather than describing future
work:

| Result | What it demonstrates | Source |
| --- | --- | --- |
| First AgentOS baseline | Five declared Quickstart attempts: three passed, one failed and one incomplete; every attempt and unavailable observation is retained. | [Human report](./results/agentos/README.md) · [compact manifest](./results/agentos/quickstart-to-delivery-v0.1.0.json) |
| Interrupted-worker recovery | One held-out attempt resumed the same accepted work with no loss, duplicate effect, human repair or authority violation. | [Immutable evidence](https://github.com/akua-dev/agentos/releases/tag/benchmark-v0.1.0-agentos-recovery-02) |
| Reviewed improvement loop | One unchanged incomplete pilot produced a falsifiable change, two passing counterfactual reruns and a passing held-out scenario. | [Issue #20](https://github.com/akua-dev/agentos/issues/20) |
| Non-AgentOS portability | Native Codex CLI passed the portable scenario without AgentOS or a compatibility layer. | [Immutable evidence](https://github.com/akua-dev/agentos/releases/tag/benchmark-v0.1.0-codex-cli-quickstart-01) |

The completed [public benchmark epic](https://github.com/akua-dev/agentos/issues/14)
preserves the implementation and review history. These results are evidence for
their exact subjects and environments, not a claim of superiority over another
system.

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
5. Write a run plan that satisfies
   [`run-plan.schema.json`](./schemas/run-plan.schema.json). Commands are
   direct argument arrays for the compared system's existing public
   interfaces; the runner does not invoke a shell or provide an AgentOS
   compatibility interface. Never put credentials in a plan or command.
6. Run one attempt into a new directory:

   ```console
   bun benchmarks/run.ts path/to/run-plan.json path/to/new-attempt-directory
   ```

   The runner writes `frozen-run.json` before it invokes an interface, then
   writes exactly one schema-valid `evidence.json`. A collector prints one
   evidence document to standard output. If an evaluator command fails, the
   runner preserves the attempt as valid incomplete evidence rather than
   dropping it.
7. Validate the emitted evidence independently:

   ```console
   bun benchmarks/validate.ts evidence path/to/new-attempt-directory/evidence.json
   ```

8. Create a compact result containing every declared attempt, rubric-bound
   qualitative verdicts, per-gate mechanical verdicts, aggregate observation
   counts and each immutable raw-bundle SHA-256.
9. Recompute its gates and aggregates against the published scenario and
   catalog:

   ```console
   bun benchmarks/validate.ts result path/to/result.json
   ```

Use `$agentos-evaluation` when running the benchmark from an AgentOS checkout or
live Fleet. Use `$agentos-improvement-review` only after the run bundle is
frozen.

## Modes

- **Conformance:** requires `disposable` isolation and its approval reference.
  An optional native start or blocking trigger command runs before collection,
  independently of fault injection. A faulted scenario additionally names one
  declared fault, its approval reference when required, and its native fault
  command. The runner invokes no fault when the scenario declares none and
  rejects undeclared faults before any command runs.
- **Live:** requires a stable completed-work reference and exposes only one
  collection command. Its plan has no fault-injection surface.
- **Offline:** accepts only a conformance or live scenario plus the path and
  pre-frozen SHA-256 for its evidence. Its plan has no command surface, so the
  runner cannot contact the subject. The emitted evidence preserves the source
  run's exact validated bytes, mode, run ID and evaluator identity; the offline
  plan remains separately identifiable in `frozen-run.json`. If offline
  verification itself fails, its newly generated incomplete evidence records
  that evaluator failure instead.

The runner freezes the complete scenario and rubric plus the subject revision,
environment, permission set, evaluator and exact public-interface invocation
before measurement. Emitted evidence must match those frozen values. It never
offers mutation, repair, reload or improvement operations; conformance fault
injection is the only evaluator mutation and is limited to the selected
scenario declaration.

## Contracts

- [`SPEC.md`](./SPEC.md) owns portable semantics, metrics, gates and reporting.
- [`scenario.schema.json`](./schemas/scenario.schema.json) owns scenario shape.
- [`run-plan.schema.json`](./schemas/run-plan.schema.json) owns the portable
  runner input and its mode-specific command surface.
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
Compact official result manifests live under [`results/agentos/`](./results/agentos/)
after real runs, independent verification and immutable publication. A compact
result has no composite gate or score: a failed or unobserved gate remains
visible for every attempt.
