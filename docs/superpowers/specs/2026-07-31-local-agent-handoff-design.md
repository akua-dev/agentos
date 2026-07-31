# Local-agent handoff and README funnel design

## Problem

AgentOS explains persistent crews, accountable work, and durable delivery, but
it does not yet make one common adoption moment obvious: someone starts with a
local coding agent for fast planning, diagnosis, prototyping, or partial
implementation, then wants AgentOS to take responsibility for finishing the
outcome.

The repository README also carries much of the product explanation itself.
That makes it long, duplicates material the public website can explain better,
and weakens its job as an overview funnel.

## Goals

- Make “start locally, finish with the Fleet” a recognizable AgentOS use case.
- Teach a truthful handoff that works with current AgentOS surfaces.
- Show the return loop: Fleet evidence comes back to the human, who can refine
  locally and hand off another bounded outcome.
- Give each major README section a clear route to deeper website material.
- Reduce the README while preserving the bootstrap prompt, core positioning,
  public proof, architecture boundary, contribution path, and license notice.
- Keep one source of truth for the detailed handoff guidance.

## Non-goals

- Add a new CLI, API, webhook receiver, database function, Skill, or permanent
  First Mate instruction.
- Claim that AgentOS can import an arbitrary local transcript or working tree
  automatically.
- Turn an external event into accepted work without First Mate reconciliation.
- Rewrite the landing-page visual system or restructure unrelated Learn
  courses.
- Replace canonical architecture, operating, or contributor contracts with
  marketing copy.

## Content architecture

### Canonical operating guide

Add `website/apps/docs/content/docs/operate/continue-local-work.mdx` as the
single detailed user-facing guide. It owns:

- when a local-to-Fleet handoff is useful;
- the minimum handoff package: desired outcome, current evidence, durable
  artifact references, constraints, and authority boundary;
- the current intake paths: give the package to First Mate directly, or let an
  approved integration preserve it as an external event for later
  reconciliation;
- the distinction between evidence and accepted work;
- how First Mate converts accepted intent into a Task and accountable
  Assignment;
- how a Scout report or reviewed delivery returns to the human for the next
  local/Fleet iteration.

The guide links to canonical delegation, external-event, Task/Assignment, and
authority documentation instead of restating their full procedures.

### Learn scenario

Add a lesson after “Give the Fleet a real outcome” named “Hand off local work.”
The lesson uses four short examples—planning, prototype, diagnosis, and partial
implementation—to help readers recognize the moment. It walks through one
diagnosis handoff and links to the operating guide for the reusable checklist.

The lesson does not invent a universal command. It shows a portable request
shape and explains that a connected local agent may submit the same bounded
package through an approved durable intake.

### Landing-page use case

Add one prominent use-case section after the initial bootstrap demonstration
and before proof/principles. Its narrative is:

```text
local exploration → bounded handoff → accountable Fleet work → evidence back
```

The section names the concrete moments users recognize and links to both the
Learn lesson and canonical operating guide. It uses the existing card, type,
spacing, and button system; no new visual language is introduced.

### README overview funnel

Refactor the README into a shorter sequence:

1. Hero and product definition.
2. The attention problem and AgentOS outcome.
3. Get started.
4. Start locally, finish with the Fleet.
5. Public proof.
6. How the company works.
7. Ownership and architecture.
8. Build with us and license.

Each major section ends with a contextual website link such as “Learn the
handoff workflow,” “Explore the crew,” or “Read the architecture.” The README
keeps only enough detail to establish the idea and earn the click. Detailed
benchmarks, role explanations, adoption guidance, and architectural mechanics
move behind their existing website routes.

The target is at least a 30% reduction in README line count without removing
the canonical bootstrap prompt, benchmark result headline, source repository
links, or license references.

## Truth and authority boundaries

- A local transcript is context, not Fleet authority.
- Uncommitted local edits are not a delivery artifact. The handoff references a
  durable branch, commit, patch, issue, report, or other inspectable evidence
  when code state matters.
- An external event preserves evidence and wakes reconciliation; it does not
  accept work by itself.
- Accepted execution begins only when AgentOS records an accountable
  Assignment.
- The guide describes current capabilities and labels integrations as optional,
  not shipped universal intake.

## Verification

- Extend the landing-page component test to verify that the new use case
  exposes Learn and operating-guide destinations through accessible links.
- Register the Learn lesson in course metadata and the curriculum contract so
  existing source, navigation, and progress tests exercise it.
- Run the website docs, Learn, metadata, discovery, and site-contract tests.
- Run website lint and type checking.
- Run the repository check before delivery.
- Render or build the landing/docs application and visually inspect the new
  section at desktop and mobile widths when the local toolchain supports it.
- Confirm the README reduction and manually check every public website route.

## Delivery

Commit the implementation on `docs/local-agent-handoff`, then use the
repository-selected no-mistakes workflow to review, validate, push, open the
pull request, and wait for green required checks. Merge remains a separate
human decision.
