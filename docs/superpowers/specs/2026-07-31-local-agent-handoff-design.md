# Work handoff, human responsibility routing, and adaptive work surfaces design

## Problem

AgentOS explains persistent crews, accountable work, and durable delivery, but
it does not yet make one common adoption moment obvious: someone starts work
wherever thinking is fastest, then wants the company to take responsibility for
finishing, reviewing, testing, implementing, or delivering the outcome. That
work may be interface design, backend architecture, research, diagnosis,
implementation, quality assurance, or code review. A local coding Agent is one
useful starting point, not the boundary of the workflow.

The same gap appears at a larger scale inside a company. Work and decisions
often need wisdom from several people: the person with customer context, the
engineer who understands the constraint, the domain owner who can judge the
risk, and the human role authorized to approve the consequence. A company
should be able to configure AgentOS and its interfaces around those
responsibility paths instead of forcing every question through one generic
dashboard or treating visibility as authority.

An employee may want an interface that has already assembled the work,
decisions, and context relevant to them; presents each item in the form that
makes it easiest to judge; lets them inspect a product, review evidence, or
revise a draft with a local built-in Agent; and returns their contribution to
the accountable company loop. AgentOS provides the durable organizational
substrate for that direction, while Flect provides a concrete adaptable local
workplace today. The AgentOS integration remains future work.

The repository README also carries much of the product explanation itself.
That makes it long, duplicates material the public website can explain better,
and weakens its job as an overview funnel.

## Goals

- Make “start anywhere, hand off accountable follow-through” a recognizable
  AgentOS use case.
- Show that the handoff may carry any bounded product or company outcome,
  including interface work, architecture, research, implementation, testing,
  diagnosis, or review.
- Teach a truthful handoff that works with current AgentOS surfaces.
- Show the return loop: Fleet evidence comes back to the human, who can refine
  locally and hand off another bounded outcome.
- Show how a custom or adaptive employee interface can prepare personalized
  work, attention, context, drafts, and decision views while AgentOS remains
  the accountable system beneath it.
- Explain the broader human loop: relevant people contribute context and
  judgment, while the configured accountable role retains decision authority.
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
- Claim that AgentOS currently discovers every relevant person, exposes a
  first-class multi-person approval workflow, or that Flect currently controls
  arbitrary embedded products, browsers, or iframes.
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

- when a local-to-Fleet handoff is useful across product and company work;
- why the boundary is responsibility rather than activity, artifact type, or
  which tool started the work;
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
- the experience loop: a configured responsibility path identifies the people
  whose context, expertise, or authority matters; the interface presents the
  work appropriately; a local built-in Agent helps inspect, retrieve, or
  revise; contributors provide advice or approval within their role; and the
  result returns through an approved AgentOS intake;
- the distinction between contributing wisdom and granting authority: several
  people may inform a decision, while the configured accountable human role
  resolves the consequence;
- the boundary between replaceable presentation/local working state and
  durable Tasks, Assignments, decisions, evidence, and authority;
- examples ranging from UI and backend work to research, review, approvals,
  and a focused internal tool or adaptive workplace;
- Flect as a public developer preview of an agent-native interface layer that
  could surface AgentOS work while remaining useful beyond AgentOS.

The page links to Flect's public repository, current preview, and vision with
an explicit status label. It links to canonical AgentOS architecture and
operating pages instead of duplicating their contracts.

### Learn scenario

Add a lesson after “Give the Fleet a real outcome” named “Hand off local work.”
The lesson uses examples from interface shaping, backend architecture,
prototyping, diagnosis, implementation, testing, and review to help readers
recognize the moment. It keeps one concrete diagnosis example, but does not
reproduce the reusable handoff checklist or acceptance procedure; it links
those mechanics to the canonical operating guide.

The lesson does not invent a universal command. It explains that a connected
local agent may submit the bounded package through an approved durable intake,
with the operating guide owning the package and acceptance mechanics.

End the lesson with a short “bring the company into the loop” callout: the same
bounded handoff can originate in a custom employee workplace that prepares
relevant work and seeks judgment from the appropriate people. Link to the
canonical work-surface concept rather than teaching a second workflow in the
lesson.

### Landing-page local handoff

Add a prominent local-handoff section after the initial bootstrap
demonstration and before proof/principles. It shows how work enters and returns
from the Fleet:

```text
local exploration → bounded handoff → accountable Fleet work → evidence back
```

The section names UI work, backend architecture, implementation, diagnosis,
testing, and code review, and links to the Learn lesson and operating guide. It
uses the existing AgentOS card, type, spacing, and button system.

### Landing-page Flect story

Give Flect one restrained AgentOS × Flect concept section after the
local-handoff section. Its only product visual is the genuine official Flect
README hero from `akua-dev/flect` `main`, copied into the website's public
assets as `assets/flect-hero.png`; the page does not recreate Flect's product
or hotlink a runtime image.

The section labels Flect as a public developer preview and AgentOS as a
natural future dogfooding adopter. It explicitly says that the AgentOS × Flect
workflow is a future direction, not a shipped integration, and that Flect works
beyond AgentOS. The copy positions Flect as an adaptable front door to product
and company work: shape a workspace locally today; eventually assemble the
right context, let relevant people and the built-in Agent inspect or revise the
work, and return approved intent to the Fleet. An early integration may present
an approved existing product through a bounded embedded browser or iframe
before deeper product adapters exist, but neither path is claimed as shipped.
AgentOS remains the durable authority for accepted work, decisions, evidence,
and handoff.

Use semantic image alt text and links to Flect's repository/current preview and
the canonical human-work-surfaces docs. The official hero is the section's
only product or workflow visual. Describe the possible future workflow in
prose; do not animate, diagram, or mock an AgentOS integration before a real
dogfooded workflow exists. Remove scenario state, the fabricated workspace,
built-in-agent rail, animated handoff sequence, and second mock/demo section.
No new animation dependency, autoplay video, cross-origin runtime media, or
runtime/intake mechanism is needed.

### README overview funnel

Refactor the README into a shorter sequence:

1. Hero and product definition.
2. The attention problem and AgentOS outcome.
3. Get started.
4. Start anywhere, hand off accountable follow-through.
5. Give the company an adaptable workplace.
6. Public proof.
7. How the company works.
8. Ownership and architecture.
9. Build with us and license.

Each major section ends with a contextual website link such as “Learn the
handoff workflow,” “Explore the crew,” or “Read the architecture.” The README
keeps only enough detail to establish the idea and earn the click. Detailed
benchmarks, role explanations, adoption guidance, and architectural mechanics
move behind their existing website routes.

The workplace section remains brief: it explains that an interface may
personalize work, attention, and presentation; invite the people with relevant
context or authority; and return their contribution while AgentOS keeps durable
authority. It may name Flect as a public developer-preview example and natural
dogfooding adopter, not as a bundled AgentOS feature.

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
- Relevant contributors can provide context, critique, or recommendations
  without becoming the accountable owner or granting authority they do not
  hold. The configured Captain role or exact standing authorization remains the
  decision boundary for consequences.
- Flect works as a standalone/local interface shell today. AgentOS adapters and
  arbitrary embedded-product control are future integration concepts, not
  current capabilities.
- The guide describes current capabilities and labels integrations as optional,
  not shipped universal intake.

## Verification

- Extend the landing-page component test to verify that the new use case
  exposes Learn, operating-guide, and work-surface destinations through
  accessible links and accurately labels Flect's status and concept boundary.
- Add an observable component test for the official hero, honest future-status
  copy, image alt text, and canonical Flect/work-surface links.
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
