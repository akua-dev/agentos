---
name: agentos-decisions
description: Preserve unresolved Captain choices discovered by investigations or reviews and route their answers durably. Use before completing a Scout or structured review, when linking dependent Tasks to a Captain choice, and when recording or resolving the Captain's exact answer.
---

# Preserve Captain decisions

PostgreSQL Inbox owns the decision. Do not infer choices from report prose with
a script, create a fake Task for the question, or add another decisions table.

## Hold and attest

1. Read the complete report or review surface and semantically inventory only
   genuine unresolved choices requiring the Captain.
2. Give each choice a stable, privacy-safe key. Use
   `agentos.hold_captain_decision(task_id, key, subject, body, status_text)`.
   Exact retry is idempotent; a conflicting reuse fails closed.
3. Link accepted work that cannot proceed with
   `agentos.link_task_decision(task_id, key, status_text)`. The dependency lives
   in the Task's existing `dependencies` array.
4. Before ending a `scout` or `review` Assignment as completed, call
   `agentos.attest_assignment_decisions(assignment_id, keys)`. Pass the complete
   unresolved set, including an explicit empty array. PostgreSQL rejects an
   omitted or partial inventory.

The originating Assignment may finish after attestation while its decision
remains open. Completion, report archival, Pod loss or Agent retirement never
resolve the Captain choice.

## Present and resolve

- Present the outcome, options, consequence and requested choice in normal
  language. Do not expose internal "hold" mechanics in ordinary Captain chat.
- After the Captain answers, call
  `agentos.resolve_captain_decision(decision_id, exact_answer, status_text)` in
  the same short transaction as any coupled local state changes.
- Resolution stores the exact answer as an append-only Inbox reply, closes the
  original decision and removes matching Task dependency edges atomically.
  Supervision then re-evaluates newly unblocked work.
- A repeated identical resolution returns the existing answer. A different
  answer for an already resolved decision fails closed and requires explicit
  follow-up rather than history rewriting.

Fleet-wide status reads structured Inbox and Task state. Never reconstruct open
choices by scraping old reports, terminal output, visual artifacts or chat.
