---
name: agentos-evaluation
description: Evaluate an Agent organization through the public AgentOS benchmark. Use when measuring Quickstart, Fleet delivery, composition integrity, recovery, human attention, efficiency, robustness, safety or accountability; running conformance, live or offline evaluations; or producing and validating a sanitized evidence bundle.
---

# Evaluate an Agent organization

Measure the organization without changing it. Keep evidence portable,
sanitized and independently reviewable.

## Select and freeze the run

1. Read `benchmarks/SPEC.md` and the selected versioned scenario.
2. When the subject is AgentOS, also read
   `benchmarks/profiles/agentos/PROFILE.md`.
3. Select exactly one mode:
   - `conformance`: execute a fixed scenario in a disposable environment;
   - `live`: observe completed real work without injecting faults;
   - `offline`: judge an already frozen bundle without contacting the subject.
4. Before execution, record the scenario and rubric versions, subject source
   revision and immutable images, environment, permissions, harnesses, models,
   tools, acceptance criteria, fault triggers and completion boundary.
5. Do not alter instructions, permissions or environment after measurement
   starts. Record a deviation instead of silently repairing the run.

Use conformance mode for reproducible product claims. Run a declared fault only
in an approved disposable environment. Never inject faults into live work.

## Collect bounded evidence

Operate the subject only through interfaces it already exposes. Do not add a
compatibility wrapper to make another system resemble AgentOS.

For AgentOS, gather only the evidence required by the scenario from the native
authority:

- PostgreSQL for accepted work, ownership, handoffs and Captain decisions;
- Kubernetes for workload existence, readiness and failure;
- Herdr for the terminal process, harness state and native session reference;
- the Agent PVC for retained home, native session and unfinished workspace;
- Git and the selected provider for the delivered branch, commit and review
  artifact.

For the AgentOS composition scenario, resolve the pinned manifest and
Assignment from PostgreSQL, exact selected bytes and digests from the bounded
bundle, native origin revisions from their own interfaces, Pod-side verifier
result from the worker runtime, loaded context from the exact harness and
Herdr Agent, real capabilities from their independent authorities, and the
debrief from immutable completion history. Treat desired persistent composition
as distinct from observed native activation. Do not copy material bodies or
complete sessions into the evidence bundle merely to prove their digest.

Session files are optional evidence. When authorized, normalize only tool name,
sanitized arguments, result or error class, timing and retry relationships.
Never publish raw reasoning, chain-of-thought, credentials, full private
transcripts or unrelated terminal output.

Give every metric one of `observed`, `unobserved` or `not-applicable`.
`unobserved` needs a reason and never means zero. Preserve failed and incomplete
attempts; do not select only successful runs.

## Judge and freeze

1. Verify the outcome and each acceptance criterion independently. A subject's
   completion claim is not a verdict.
2. Evaluate effectiveness, human attention, resource efficiency, robustness,
   safety and accountability separately.
3. Apply every applicable hard gate. Never average a failed gate into a score.
4. Produce one evidence document per attempt that conforms to
   `benchmarks/schemas/evidence-bundle.schema.json`.
5. Freeze the raw bundle as an immutable artifact. Put its URI and SHA-256 in a
   compact result manifest; do not create a self-referential digest inside the
   evidence JSON.
6. Validate each attempt:

   ```console
   bun benchmarks/validate.ts evidence path/to/evidence.json
   ```

7. Publish every attempt in the declared run set with exact revisions,
   evaluator identity, rubric version, redactions and limitations.

Do not mutate, reload, deploy or improve the measured subject during the run.
After the evidence is frozen, use `$agentos-improvement-review` as a separate
activity.
