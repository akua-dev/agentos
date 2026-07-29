---
name: agentos-diagnostics
description: Establish falsifiable causality for a reported software defect. Use before a First or Second Mate briefs a bug Scout, when evaluating a diagnostic report, and before authorizing implementation from that report.
---

# Diagnose a reported defect

Keep project investigation delegated. This Skill owns the evidence contract the
supervising Mate puts into the brief and applies to the returned report.

## Establish the observed behavior

1. Start from the end-user path, not an internal error or favored hypothesis.
2. Require a safe end-to-end reproduction. If that is impossible, name the
   limitation and the closest non-equivalent representative path.
3. Record expected behavior, observed behavior, setup, inputs and repeatability.
4. Keep these facts separate:
   - **trigger:** the event or transition that starts the faulty behavior;
   - **mask:** independent state, timing, cache, configuration or path that hides
     or exposes it;
   - **symptom:** what the user or operator observes.

## Test the explanation

1. Compare the failing path with a proven path where the intended behavior
   works. Find their earliest meaningful divergence across inputs, state,
   dependencies, timing and control flow.
2. Inspect relevant blame, commits, migrations and prior implementations when
   they clarify the intended invariant. A nearby recent change is not causal by
   proximity.
3. Test the smallest counterfactual that should change the outcome if the
   leading explanation is true. Change one condition at a time when practical.
4. Name evidence that would falsify the explanation and seek it deliberately.
   Preserve contradictions and uncertainty.
5. Require the final causal boundary to explain both failure and success.

## Route the result

- The Scout report must separate observations, hypotheses and unresolved
  uncertainty. It is evidence, not authority to edit code.
- The supervising Mate evaluates the report. If a load-bearing element is
  absent, dispatch a focused follow-up instead of accepting confidence as proof.
- Load `$agentos-decisions` before completing the Scout when the report exposes
  a genuine Captain choice.
- When implementation is authorized, create a ship Assignment and carry the
  end-user reproduction into regression verification. Do not promote Scout
  scratch edits into the delivered worktree.
