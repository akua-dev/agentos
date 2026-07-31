# Local-agent handoff, adaptive work surfaces, and README funnel design

## Problem

AgentOS explains persistent crews, accountable work, and durable delivery, but
it does not yet make one common adoption moment obvious: someone starts with a
local coding agent for fast planning, diagnosis, prototyping, or partial
implementation, then wants AgentOS to take responsibility for finishing the
outcome.

The same gap appears at a larger scale inside a company. An employee may want
an interface that has already assembled the decisions and context relevant to
them, presents each decision in the most useful form, lets them review or
revise a draft with a local built-in agent, and then sends their approved
intent back to First Mate. AgentOS provides the durable organizational
substrate for that workflow, but its public story does not yet show that its
human work surfaces can be purpose-built, replaceable, and personal.

The repository README also carries much of the product explanation itself.
That makes it long, duplicates material the public website can explain better,
and weakens its job as an overview funnel.

## Goals

- Make “start locally, finish with the Fleet” a recognizable AgentOS use case.
- Teach a truthful handoff that works with current AgentOS surfaces.
- Show the return loop: Fleet evidence comes back to the human, who can refine
  locally and hand off another bounded outcome.
- Show how a custom or adaptive employee interface can prepare personalized
  attention, context, drafts, and decision views while AgentOS remains the
  accountable system beneath it.
- Present Flect as a concrete public developer preview of a general interface
  layer and as a natural first AgentOS dogfooding adopter, without claiming a
  shipped AgentOS integration or dependency.
- Give each major README section a clear route to deeper website material.
- Reduce the README while preserving the bootstrap prompt, core positioning,
  public proof, architecture boundary, contribution path, and license notice.
- Keep one source of truth for the detailed handoff guidance.

## Non-goals

- Add a new CLI, API, webhook receiver, database function, Skill, or permanent
  First Mate instruction.
- Implement or promise an AgentOS–Flect integration, make Flect an AgentOS
  dependency, or present the proposed AgentOS adopter experience as available
  today.
- Make one UI, including Flect, the required AgentOS workplace.
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

### Canonical work-surface concept

Add `website/apps/docs/content/docs/concepts/human-work-surfaces.mdx` as the
single detailed explanation of replaceable human interfaces over AgentOS. It
owns:

- why people should be able to use a purpose-built interface without creating
  a second organizational authority;
- the experience loop: AgentOS attention and context are selected for the
  employee, the interface presents the decision appropriately, a local
  built-in agent helps retrieve context or revise a draft, the human approves,
  and the resulting intent returns through an approved AgentOS intake;
- the boundary between replaceable presentation/local working state and
  durable Tasks, Assignments, decisions, evidence, and authority;
- examples ranging from a focused internal tool to an adaptive workplace;
- Flect as a public developer preview of an agent-native interface layer that
  could surface AgentOS work while remaining useful beyond AgentOS.

The page links to Flect's public repository, current preview, and vision with
an explicit status label. It links to canonical AgentOS architecture and
operating pages instead of duplicating their contracts.

### Learn scenario

Add a lesson after “Give the Fleet a real outcome” named “Hand off local work.”
The lesson uses four short examples—planning, prototype, diagnosis, and partial
implementation—to help readers recognize the moment. It walks through one
diagnosis handoff and links to the operating guide for the reusable checklist.

The lesson does not invent a universal command. It shows a portable request
shape and explains that a connected local agent may submit the same bounded
package through an approved durable intake.

End the lesson with a short “beyond coding agents” callout: the same bounded
handoff can originate in a custom employee workplace that prepares relevant
decisions and context. Link to the canonical work-surface concept rather than
teaching a second workflow in the lesson.

### Landing-page local handoff

Add a prominent local-handoff section after the initial bootstrap
demonstration and before proof/principles. It shows how work enters and returns
from the Fleet:

```text
local exploration → bounded handoff → accountable Fleet work → evidence back
```

The section names planning, prototyping, diagnosis, and partial implementation,
and links to the Learn lesson and operating guide. It uses the existing AgentOS
card, type, spacing, and button system.

### Landing-page Flect story

Give Flect its own paced product-story moment after the local-handoff section,
using two connected sections:

1. **The interface to your AgentOS company.** An immersive, dark Flect surface
   demonstrates the proposed employee loop:

   ```text
   personalized attention → decision-specific review → agent-assisted revision
   → human approval → First Mate → durable Fleet work
   ```

   The visual is an accessible native React/CSS concept preview rather than a
   static dashboard mock. A person can switch between a product decision, an
   incident response, and a research review; the surface changes its
   presentation while preserving the same AgentOS chain of custody. Motion
   uses transforms, opacity, clipping, and restrained state signals, never
   hides essential content, and has a complete `prefers-reduced-motion`
   alternative.

2. **Flect works beyond AgentOS.** A quieter follow-on explains the two Flect
   starting points: use the thoughtful AgentOS experience unchanged or shape
   it for one person; use the same open interface shell for another product,
   API, or personal workplace. Link to Flect's current public preview, actual
   shaping demo, and repository.

The first section may borrow Flect's documented “Midnight Drafting Desk”
palette and precise rose agency signal as one deliberately art-directed island
inside the established AgentOS page. The rest of the landing page remains in
the AgentOS visual system. The preview is labeled “AgentOS × Flect concept” so
its proposed integration cannot be mistaken for current product behavior.

Use no new animation dependency, autoplay video, cross-origin runtime media,
or heavyweight shader. The DOM remains meaningful without JavaScript, manual
scenario controls remain keyboard accessible, and decorative motion pauses
under reduced-motion preference. Link to Flect's real v0.2 demo rather than
copying it or replacing its product truth with a generated marketing video.

### README overview funnel

Refactor the README into a shorter sequence:

1. Hero and product definition.
2. The attention problem and AgentOS outcome.
3. Get started.
4. Start locally, finish with the Fleet.
5. Bring your own workplace.
6. Public proof.
7. How the company works.
8. Ownership and architecture.
9. Build with us and license.

Each major section ends with a contextual website link such as “Learn the
handoff workflow,” “Explore the crew,” or “Read the architecture.” The README
keeps only enough detail to establish the idea and earn the click. Detailed
benchmarks, role explanations, adoption guidance, and architectural mechanics
move behind their existing website routes.

“Bring your own workplace” remains brief: it explains that an interface may
personalize attention and presentation while AgentOS keeps durable authority,
then links to the canonical work-surface concept. It may name Flect as a
public developer-preview example and natural dogfooding adopter, not as a
bundled AgentOS feature.

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
- A custom interface can cache presentation or local draft state, but it does
  not mirror AgentOS into a competing task, decision, or authority store.
- A built-in interface agent can retrieve, explain, and revise within its
  granted capabilities. Human approval and AgentOS intake still govern
  consequential action.
- The guide describes current capabilities and labels integrations as optional,
  not shipped universal intake.

## Verification

- Extend the landing-page component test to verify that the new use case
  exposes Learn, operating-guide, and work-surface destinations through
  accessible links and accurately labels Flect's status and concept boundary.
- Add an observable component test for the Flect scenario controls: selecting
  another decision changes the visible, labeled decision surface while
  preserving the approval-to-First-Mate path.
- Register the Learn lesson in course metadata and the curriculum contract so
  existing source, navigation, and progress tests exercise it.
- Run the website docs, Learn, metadata, discovery, and site-contract tests.
- Run website lint and type checking.
- Run the repository check before delivery.
- Render or build the landing/docs application and visually inspect the new
  section at desktop and mobile widths when the local toolchain supports it.
- Inspect keyboard focus, semantic headings, text contrast, and reduced-motion
  rendering for the Flect sections.
- Confirm the README reduction and manually check every public website route,
  including the work-surface concept and Flect source link.

## Delivery

Commit the implementation on `docs/local-agent-handoff`, then use the
repository-selected no-mistakes workflow to review, validate, push, open the
pull request, and wait for green required checks. Merge remains a separate
human decision.
