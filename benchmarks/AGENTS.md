# Public benchmark boundary

This directory owns the portable benchmark specification, versioned scenarios,
machine-readable contracts, AgentOS profile and compact official results.

- Keep the portable core neutral. Use `principal`, `supervisor`, `worker`,
  accepted outcome and review artifact; map AgentOS vocabulary only in
  `profiles/agentos/`.
- Fix a scenario, rubric, environment and permission set before execution.
  Publish every attempt in the declared run set.
- Keep effectiveness, attention, efficiency, robustness, safety and
  accountability separate. Never add a composite score that can average away a
  failed hard gate.
- Mark unavailable evidence `unobserved`. Never infer zero from absent
  provider, harness or human-attention telemetry.
- Exclude raw reasoning, chain-of-thought, credentials and unredacted private
  transcripts from fixtures, results and evidence bundles.
- Store only synthetic fixtures under `tests/fixtures/`. A result belongs under
  `results/` only after a real run, independent verification and an immutable
  raw-evidence digest exist.
- Keep raw evidence outside the source tree when it is large. Commit a compact
  result manifest that resolves the immutable artifact and its digest.
- Measurement never mutates the subject under evaluation. Improvement starts
  only from a frozen bundle through `$agentos-improvement-review`.
- Validate observable JSON contracts and command behavior. Do not add tests
  that search Markdown for selected wording.
