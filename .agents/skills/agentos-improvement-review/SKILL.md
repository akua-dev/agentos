---
name: agentos-improvement-review
description: Turn a frozen AgentOS evaluation into the smallest reviewed, regression-tested improvement. Use after benchmark or operational evidence exposes wrong tool use, repeated trial and error, unclear instructions, stale Skill guidance, runtime failure, an authority violation or another reproducible Fleet weakness.
---

# Improve AgentOS from frozen evidence

Diagnose a measured failure without teaching the live subject during its run.
Treat the evidence as an input to normal reviewed development, not permission
for automatic self-rewriting.

## Establish the evidence boundary

1. Read `benchmarks/SPEC.md`, the applicable scenario and, for AgentOS,
   `benchmarks/profiles/agentos/PROFILE.md`.
2. Confirm the evidence bundle is frozen and validate it:

   ```console
   bun benchmarks/validate.ts evidence path/to/evidence.json
   ```

3. Do not contact or mutate the measured subject merely to fill a gap. Mark the
   limitation unless the user starts a separate diagnostic investigation.
4. Separate observed evidence from evaluator inference.

## Find the smallest falsifiable cause

Classify the earliest cause that would have changed the outcome:

- unclear or contradictory human intent;
- an always-loaded `AGENTS.md` rule that is absent, misplaced or conflicting;
- a Skill that is missing, stale, undiscoverable or triggered at the wrong
  boundary;
- unclear native-tool documentation or an unusable error;
- a missing deterministic primitive;
- harness or model behavior;
- runtime, persistence or infrastructure failure;
- an incorrect authority or permission boundary;
- an external provider failure.

Distinguish the trigger, the observed symptom, anything that merely masked the
failure, and the causal counterfactual: the smallest change that should prevent
it. Long trial-and-error is evidence of a navigation or feedback defect, not
automatically evidence that another wrapper CLI is needed.

## Make a reviewed improvement

1. Propose the smallest change at the source that owns the behavior. Keep
   permanent identity and safety in `AGENTS.md`, conditional judgment in one
   Skill, and deterministic mechanics in SQL or TypeScript.
2. Load `$agentos-development` and follow the normal repository review and
   delivery path. Never rewrite production instructions automatically from one
   anomalous run.
3. Add a behavior regression test when code or a machine-readable contract
   changes. Add or revise a benchmark scenario only when the public behavior
   contract itself changes.
4. Rerun the failing scenario with the original frozen configuration, then a
   predeclared held-out scenario. Reject an improvement that weakens a safety,
   accountability or outcome gate.
5. Publish before-and-after evidence, exact revisions and remaining
   uncertainty. A plausible explanation without counterfactual evidence is a
   hypothesis, not a learned improvement.

Do not hot-reload or deploy the change into a live Fleet unless that separate
action is explicitly authorized.
