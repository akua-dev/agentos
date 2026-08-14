# AgentOS reference stack

> **Status:** Draft architecture direction. This directory does not authorize
> implementation, deployment, migration, deletion, merge or provider access.

AgentOS should make a planning-first company operating loop possible:

```text
people in a shared conversation, meeting or product surface
→ First Mate clarifies intent, evidence, trade-offs and missing decisions
→ accepted architecture and delivery specifications
→ specialist agents execute bounded work in isolated environments
→ tested, maintainable, observable source candidates and one or more PRs
→ people review the exact planned outcome and retain consequential gates
→ results, incidents and operational evidence become the next decision inputs
```

The First Mate is the human-facing coordination and decision-support layer. It
maintains the overview, removes bottlenecks, asks the questions that avoid
costly rework, delegates specialist work and returns reviewable outcomes. It
does not need to perform every implementation task itself.

A chat, voice meeting, shared canvas, live browser view, source view or scoped
remote sandbox view can be a collaboration surface. None becomes a second task,
approval, credential or acceptance authority. A shared live view requires a
scoped, revocable capability and preserves worker isolation and secret
boundaries.

This direction is intentionally broader than one chat product or one runtime.
The recommended initial reference stack is Hermes First-Mate plus AgentOS
runtime/access infrastructure. Company-specific profiles, skills, processes and
later compatible parent implementations remain possible.

## Reading order

1. [Decision register](./review/decision-register.md) — current status and
   decision counts.
2. [AgentOS Control Plane](../agentos-control-plane.md) — technical reference
   stack, contracts, current-source reconciliation and failure requirements.
3. Repository-root [`VISION.md`](../../../VISION.md) — the product vision. Its
   next revision must be explicitly reviewed; this draft does not replace it.

The Markdown in this directory is version-controlled shared architecture
material. A local worktree is only the preparation area for normal source
review, not a parallel knowledge silo.
