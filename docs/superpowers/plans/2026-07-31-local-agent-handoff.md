# Work handoff and Flect workplace implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make any-work-to-Fleet handoff, human responsibility routing, and a truthful future Flect workplace direction obvious across the AgentOS landing page, Learn, docs, and a shorter README funnel.

**Architecture:** Keep operating truth in one handoff guide and interface boundaries in one concept page. Treat handoff as a responsibility boundary that can carry product or company work, and treat human routing as a configured contribution-and-authority path rather than a second ownership model. Keep one restrained server-rendered Flect concept section with the official README hero and explicit current-versus-future copy; existing Learn and Docs contracts remain the route/navigation authorities.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, CSS Modules, Fumadocs MDX, Vitest, Testing Library, Bun.

## Global Constraints

- AgentOS remains the authority for Tasks, Assignments, Inbox decisions, authority, and durable evidence; the interface remains a replaceable surface.
- Flect is a public developer preview and natural dogfooding adopter, not a bundled AgentOS dependency or shipped AgentOS integration.
- Label the section `AgentOS × Flect concept`; do not claim current integration behavior.
- Use the official `akua-dev/flect` `main` README hero copied to `website/apps/docs/public/assets/flect-hero.png`; do not hotlink it or recreate the product UI.
- State that Flect is a public developer preview, works beyond AgentOS, and is a natural future AgentOS dogfooding adopter. State that the AgentOS × Flect workflow is future direction only.
- Keep the official Flect hero as the section's only product or workflow visual; describe the future AgentOS workflow in prose without an animation, diagram, or mock interface.
- Add no CLI, API, webhook receiver, database mechanic, Skill, agent instruction, animation dependency, autoplay video, or cross-origin runtime media.
- A local transcript is context, an external event is evidence, and accepted execution starts only with an accountable Assignment.
- Handoff may carry UI work, backend architecture, research, implementation, testing, diagnosis, or review; a local coding Agent is one entry point rather than the workflow boundary.
- Relevant people may contribute context, critique, or recommendations without becoming the accountable owner or granting authority they do not hold.
- The configured Captain role or exact standing authorization remains the decision boundary for consequential action.
- Installing Flect provides its current standalone/local interface-shaping experience. AgentOS adapters and arbitrary embedded browser or iframe control remain future integration concepts.
- Preserve the exact bootstrap prompt, benchmark headline, source links, contribution path, and licenses.
- Reduce `README.md` from 228 lines to at most 159 lines.
- Essential content must render without JavaScript.
- Use meaningful image alt text, canonical links, and no fabricated interactive workflow.

---

### Task 0: Prepare and baseline the isolated worktree

**Files:**
- No source changes.

- [ ] **Step 1: Verify the Treehouse lease and branch**

```console
treehouse status
git status --short --branch
git rev-parse --show-toplevel
```

Expected: the root is `/Users/robin/.treehouse/agentos-e590c7/6/agentos`, the
branch is `docs/local-agent-handoff`, and no unrelated product changes exist.

- [ ] **Step 2: Install the locked toolchain and dependencies**

```console
mise install --locked
bun install --frozen-lockfile
```

Expected: both commands exit 0 without changing `mise.lock` or `bun.lock`.

- [ ] **Step 3: Establish the focused baseline**

```console
bun run --cwd website/apps/docs test components/landing-page.test.tsx scripts/docs-contract.test.ts scripts/learn-contract.test.ts
```

Expected: all existing focused suites pass before feature edits.

### Task 1: Establish and implement the landing behavior

**Files:**
- Modify: `website/apps/docs/components/landing-page.test.tsx`
- Create: `website/apps/docs/components/flect-workplace.test.tsx`
- Modify: `website/apps/docs/app/(home)/flect-workplace.tsx`
- Modify: `website/apps/docs/app/(home)/flect-workplace.module.css`
- Create: `website/apps/docs/public/assets/flect-hero.png`
- Modify: `website/apps/docs/app/(home)/page.tsx`

**Interfaces:**
- Produces: `FlectWorkplace(): ReactElement`.
- Produces the official Flect hero with meaningful alt text.
- Produces canonical Learn, operating-guide, work-surface, and Flect links plus honest future-status copy.

- [ ] **Step 1: Write failing landing-route assertions**

Mock `FlectWorkplace` in `landing-page.test.tsx`, then assert the links:

```tsx
expect(screen.getByRole('link', { name: 'Hand off local work' })).toHaveAttribute(
  'href',
  '/learn/01-first-outcome/hand-off-local-work',
);
expect(screen.getByRole('link', { name: 'Use the handoff guide' })).toHaveAttribute(
  'href',
  '/docs/operate/continue-local-work',
);
expect(screen.getByRole('link', { name: 'Design a human work surface' })).toHaveAttribute(
  'href',
  '/docs/concepts/human-work-surfaces',
);
expect(screen.getByRole('link', { name: 'Explore Flect' })).toHaveAttribute(
  'href',
  'https://github.com/akua-dev/flect',
);
```

- [ ] **Step 2: Write the failing Flect content test**

Create `flect-workplace.test.tsx` with Testing Library and assert the official
hero image, meaningful alt text, public-preview status, future-direction copy,
and the repository/current-preview and human-work-surfaces links. Assert that
the official hero is the only workflow visual and no animated handoff list is
rendered.

- [ ] **Step 3: Verify RED**

Run:

```console
bun run --cwd website/apps/docs test components/landing-page.test.tsx components/flect-workplace.test.tsx
```

Expected: FAIL because the official hero, copy, and links are missing.

- [ ] **Step 4: Implement the Flect component and asset**

Copy the official `https://raw.githubusercontent.com/akua-dev/flect/main/assets/flect-hero.png`
into `website/apps/docs/public/assets/flect-hero.png`. Render one restrained
section with the `AgentOS × Flect concept` label, the official hero image,
meaningful alt text, status copy, and links to Flect's repository/current
preview and `/docs/concepts/human-work-surfaces`. Explain the future workflow
as personalized context and decisions, agent-assisted revision, explicit human
approval, and bounded handoff to First Mate after a real integration is built
and dogfooded. Keep that workflow in prose and use the official hero as the
only product or workflow visual; remove the animated sequence, all scenario
state, mock workspace and agent rail.

- [ ] **Step 5: Compose the landing stories**

Immediately after the bootstrap demo, add a full-width local-handoff section:

```text
Start where you think fastest. Hand off when the outcome matters.
Plan · Prototype · Diagnose · Partially implement
Local evidence → bounded handoff → accountable Fleet work → reviewed result
```

Add links `Hand off local work` and `Use the handoff guide`, then render the
single `<FlectWorkplace />` section before `Proof before promises.`.

- [ ] **Step 6: Verify GREEN and commit**

Run the focused tests, then:

```console
git add website/apps/docs/app/\(home\) website/apps/docs/public/assets/flect-hero.png website/apps/docs/components/landing-page.test.tsx website/apps/docs/components/flect-workplace.test.tsx
git commit -m "feat(website): show local handoff and Flect workplace"
```

### Task 2: Publish one canonical guide for each workflow

**Files:**
- Create: `website/apps/docs/content/docs/operate/continue-local-work.mdx`
- Modify: `website/apps/docs/content/docs/operate/meta.json`
- Create: `website/apps/docs/content/docs/concepts/human-work-surfaces.mdx`
- Modify: `website/apps/docs/content/docs/concepts/meta.json`
- Modify: `website/apps/docs/scripts/docs-contract.ts`
- Modify: `website/apps/docs/scripts/docs-contract.test.ts`

**Interfaces:**
- Produces `/docs/operate/continue-local-work`.
- Produces `/docs/concepts/human-work-surfaces`.

- [ ] **Step 1: Update the contract test first**

Change the route count from 55 to 57 and assert both new paths and titles.

- [ ] **Step 2: Verify RED**

```console
bun run --cwd website/apps/docs test scripts/docs-contract.test.ts
```

Expected: FAIL with 55 routes and missing paths.

- [ ] **Step 3: Register routes and navigation**

Add:

```ts
['concepts/human-work-surfaces', 'Human work surfaces']
['operate/continue-local-work', 'Continue local work with the Fleet']
```

Place the concept after organizational attention and the guide after delegate outcome in both contract and `meta.json`.

- [ ] **Step 4: Write the handoff guide**

Frontmatter:

```yaml
---
title: Continue local work with the Fleet
description: Turn local exploration into bounded, accountable Fleet work without pretending a transcript is authority.
canonical:
  - label: Chain-of-custody architecture
    path: ARCHITECTURE.md
  - label: Delegation procedure
    path: packages/agentos/skills/agentos-delegation/SKILL.md
  - label: External event schema
    path: database/migrations/0000_initial_fleet_schema.sql
---
```

Own these sections: `Recognize the handoff moment`, `Package the outcome`, `Choose the current intake`, `Know when work is accepted`, and `Continue the loop`. The exact package is desired outcome, current evidence, durable artifact references, constraints, and authority boundary. Explain direct First Mate intake and approved external-event preservation. State that the event remains evidence until reconciliation creates or links accepted work and an accountable Assignment.

- [ ] **Step 5: Write the work-surface concept**

Use canonical links to `VISION.md` and `ARCHITECTURE.md`. Own: `Personalize attention, not authority`, `A useful employee loop`, `What stays replaceable`, `What stays durable`, and `Flect as the first adopter`. Link Flect's public preview and vision. State that the AgentOS adopter experience is proposed and Flect is useful beyond AgentOS.

- [ ] **Step 6: Verify and commit**

```console
bun run --cwd website/apps/docs test scripts/docs-contract.test.ts lib/content/canonical-source.test.ts
git add website/apps/docs/content/docs website/apps/docs/scripts/docs-contract.ts website/apps/docs/scripts/docs-contract.test.ts
git commit -m "docs(site): explain handoffs and human work surfaces"
```

### Task 3: Teach the local-to-Fleet handoff in Learn

**Files:**
- Create: `website/apps/docs/content/learn/01-first-outcome/hand-off-local-work.mdx`
- Modify: `website/apps/docs/content/learn/01-first-outcome/meta.json`
- Modify: the three later course-one MDX lesson-order values
- Modify: `website/apps/docs/scripts/learn-contract.ts`
- Modify: `website/apps/docs/scripts/learn-contract.test.ts`

**Interfaces:**
- Produces `/learn/01-first-outcome/hand-off-local-work` at global position 3.
- Preserves sequential lesson orders 1 through 6 in course one.

- [ ] **Step 1: Update the curriculum test first**

Change expected chapters and unique sizes from 10 to 11, positions to 1 through 11, and assert:

```ts
expect(learningRoutes[2]).toMatchObject({
  path: '/learn/01-first-outcome/hand-off-local-work',
  title: 'Hand off local work',
});
```

- [ ] **Step 2: Verify RED**

```console
bun run --cwd website/apps/docs test scripts/learn-contract.test.ts
```

Expected: FAIL with ten lessons and no handoff route.

- [ ] **Step 3: Register and write the lesson**

Insert the new lesson after `give-fleet-outcome` in the contract and metadata. Set its `lessonOrder: 3`; shift watch, decision, and delivery to 4, 5, and 6.

Use standard course-one frontmatter, `estimatedMinutes: 5`, delegation and architecture canonical sources, and sections:

- `Recognize the moment`: planning, prototype, diagnosis, partial implementation.
- `Hand off the outcome, not the transcript`: one concrete diagnosis example, linked to the canonical guide for the reusable package.
- `Let First Mate accept responsibility`: link to the canonical guide for evidence/event versus Task/Assignment acceptance mechanics; do not restate that procedure.
- `Take the evidence back`: review locally, refine, and issue another bounded handoff.
- `Beyond coding agents`: link `/docs/concepts/human-work-surfaces`.

End at `/learn/01-first-outcome/watch-and-steer`.

- [ ] **Step 4: Verify and commit**

```console
bun run --cwd website/apps/docs test scripts/learn-contract.test.ts lib/learn/curriculum.test.ts lib/learn/source.test.ts
git add website/apps/docs/content/learn/01-first-outcome website/apps/docs/scripts/learn-contract.ts website/apps/docs/scripts/learn-contract.test.ts
git commit -m "docs(learn): teach local work handoff"
```

### Task 4: Turn the README into the website funnel

**Files:**
- Modify: `README.md`

**Interfaces:**
- Links to `https://agentos.akua.dev` for deeper content.
- Preserves the exact two-line bootstrap prompt.

- [ ] **Step 1: Rewrite to nine concise sections**

Use: product definition; attention problem; Get started; Start locally/finish with Fleet; Bring your own workplace; Proof; Company operation; Native architecture; Build/license. End each major section with a contextual website link. Keep only the four-row benchmark headline. Remove duplicated role details, methodology, adoption essay, and architecture mechanics.

- [ ] **Step 2: Verify size and links**

```console
test "$(wc -l < README.md)" -le 159
rg -n "https://agentos.akua.dev/(learn|docs/)" README.md
rg -n "Read https://github.com/akua-dev/agentos/blob/main/BOOTSTRAP.md" README.md
```

Expected: all exit 0.

- [ ] **Step 3: Commit**

```console
git add README.md
git commit -m "docs: turn README into website overview"
```

### Task 5: Verify design and repository integrity

- [ ] **Step 1: Run website verification**

```console
bun run site:test
bun run site:lint
bun run site:typecheck
bun run site:build
```

Expected: all exit 0 without new warnings.

- [ ] **Step 2: Run repository verification**

```console
bun run check
```

Expected: exit 0.

- [ ] **Step 3: Perform browser QA**

Run `bun run site:dev` and inspect with `chrome-devtools-axi` near 1440 px and 390 px. Verify the official hero, status and future-direction copy, image alt text, heading hierarchy, contrast, overflow, and every new internal/external destination.

- [ ] **Step 4: Confirm a clean branch**

```console
git diff --check origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, clean worktree, and only task commits.

### Task 6: Deliver the pull request

- [ ] **Step 1: Start no-mistakes**

```console
no-mistakes axi
no-mistakes axi run --intent "Make AgentOS's local-to-Fleet handoff recognizable across the landing page, Learn, canonical docs, and a README reduced by at least 30% into a website funnel. Give Flect one restrained AgentOS × Flect landing section using the official Flect README hero copied into local public assets as the only product or workflow visual. Describe the possible future workflow in prose without an animation, diagram, or mock interface. Present Flect accurately as a public developer preview and natural future AgentOS dogfooding adopter, make clear the integration is not shipped and Flect works beyond AgentOS, keep AgentOS as durable authority, and add no new runtime or intake mechanism. Do not merge."
```

- [ ] **Step 2: Drive gates**

Approve no-op findings, authorize low-risk auto-fixes through `axi respond --action fix`, and stop for Robin on any `ask-user` finding. Never edit directly while the run is active.

- [ ] **Step 3: Stop at `checks-passed`**

Report the PR URL, required checks, findings, and every pipeline fix. Do not merge.

### Task 7: Broaden the finished story from coding handoff to company work

**Files:**
- Modify: `website/apps/docs/components/landing-page.test.tsx`
- Modify: `website/apps/docs/components/flect-workplace.test.tsx`
- Modify: `website/apps/docs/components/layouts/default/default-layout.test.tsx`
- Modify: `website/apps/docs/components/layouts/default/index.tsx`
- Modify: `website/apps/docs/app/(home)/page.tsx`
- Modify: `website/apps/docs/app/(home)/flect-workplace.tsx`
- Modify: `website/apps/docs/content/docs/operate/continue-local-work.mdx`
- Modify: `website/apps/docs/content/docs/concepts/human-work-surfaces.mdx`
- Modify: `website/apps/docs/content/learn/01-first-outcome/hand-off-local-work.mdx`
- Modify: `README.md`

**Interfaces:**
- Preserves the existing routes, component exports, official Flect hero, and canonical source boundaries.
- Expands the observable landing copy from coding phases to UI, architecture, research, implementation, testing, diagnosis, and review.
- Separates relevant human contribution from accountable ownership and consequential authority.
- Separates Flect's current local interface-shaping experience from future AgentOS and embedded-product adapters.

- [ ] **Step 1: Add failing observable-content tests**

In `landing-page.test.tsx`, render `Page` and assert the heading `Start anywhere. Bring in the Fleet when the outcome matters.` plus visible examples `UI direction`, `backend architecture`, and `code review`.

In `flect-workplace.test.tsx`, render `FlectWorkplace` and assert the heading `One front door to the work of your company.`, current-state copy containing `adaptable local workplace today`, relevant-person copy containing `context, expertise, or authority`, and future-state copy containing `embedded browser or iframe` and `future integration path, not a shipped capability`.

- [ ] **Step 2: Verify RED**

```console
bun run --cwd website/apps/docs test components/landing-page.test.tsx components/flect-workplace.test.tsx
```

Expected: FAIL because the current rendered page still limits the examples to planning, prototyping, diagnosis, and partial implementation and does not expose the broader Flect workplace contract.

- [ ] **Step 3: Update the landing page and Flect section**

Change the handoff heading to `Start anywhere. Bring in the Fleet when the outcome matters.` Explain that someone may shape a UI, sketch backend architecture, research, implement, diagnose, test, or review locally before handing off accountable follow-through. Keep the existing four-step evidence/acceptance loop, but make its first step cover a UI direction, architecture sketch, research finding, patch, or review.

Change the Flect heading to `One front door to the work of your company.` State that installing Flect provides an adaptable local workplace today. Describe a future AgentOS adopter that assembles the work and context, seeks contributions from people with relevant context, expertise, or authority, supports Agent-assisted inspection and revision, and returns bounded approved intent. State that a bounded embedded browser or iframe could be an early adapter before deeper product integration and label it as a future integration path, not a shipped capability.

- [ ] **Step 4: Verify GREEN**

```console
bun run --cwd website/apps/docs test components/landing-page.test.tsx components/flect-workplace.test.tsx
```

Expected: both suites pass with the new content rendered through the public components.

- [ ] **Step 5: Broaden canonical guidance, Learn, and README**

In the operating guide, replace the four coding-phase examples with interface shaping, architecture/design, research/diagnosis, and implementation/testing/review. Preserve the five-item handoff package and current intake/acceptance mechanics.

In the work-surface concept, add responsibility-path guidance: interfaces may seek wisdom from several relevant people, but contribution, accountable ownership, and authority remain distinct. Add a future bounded browser/iframe bridge and current Flect local-workplace status without claiming either AgentOS integration or arbitrary browser control ships today.

In Learn, broaden the recognition examples and replace `Beyond coding agents` with `Bring the company into the loop`. Keep the concrete checkout diagnosis and link to the canonical pages instead of duplicating mechanics.

In README, rename the handoff and workplace sections to match the broader funnel, include representative UI/backend/review work, and explain relevant-person contribution in concise future-direction language while staying at or below 159 lines.

- [ ] **Step 6: Run content and site verification**

```console
bun run --cwd website/apps/docs test components/landing-page.test.tsx components/flect-workplace.test.tsx scripts/docs-contract.test.ts scripts/learn-contract.test.ts scripts/site-contract.test.ts
bun run site:test
bun run site:lint
bun run site:typecheck
bun run site:build
test "$(wc -l < README.md)" -le 159
git diff --check
```

Expected: all commands exit 0; the README remains within its funnel target and all routes/contracts remain intact.

- [ ] **Step 7: Perform production browser QA**

Serve the built site and inspect `/`, `/docs/operate/continue-local-work`, `/docs/concepts/human-work-surfaces`, and `/learn/01-first-outcome/hand-off-local-work` at desktop and 390 px widths. Confirm the wider story, honest future labels, one official Flect visual, no horizontal overflow, correct headings and links, and no console errors.

If the docs article collapses at mobile width, first update `default-layout.test.tsx` to require the sidebar and table-of-contents widths to remain absent from inline style while the desktop breakpoint classes remain present. Verify the test fails because inline variables override Fumadocs' responsive values. Then move `18.5rem` to `md:[--fd-sidebar-width:18.5rem]!`, move `16rem` to `xl:[--fd-toc-width:16rem]!`, keep only `--fd-layout-width: 100vw` inline, rerun the test, rebuild, and repeat the 390 px and desktop inspections. The important modifier is required because Fumadocs' generated `:has(...)` rule otherwise restores its default 268 px rails after the direct utility.

- [ ] **Step 8: Commit and re-run no-mistakes**

```console
git add README.md docs/superpowers/plans/2026-07-31-local-agent-handoff.md website/apps/docs/app/\(home\)/page.tsx website/apps/docs/app/\(home\)/flect-workplace.tsx website/apps/docs/components/landing-page.test.tsx website/apps/docs/components/flect-workplace.test.tsx website/apps/docs/components/layouts/default/default-layout.test.tsx website/apps/docs/components/layouts/default/index.tsx website/apps/docs/content/docs/operate/continue-local-work.mdx website/apps/docs/content/docs/concepts/human-work-surfaces.mdx website/apps/docs/content/learn/01-first-outcome/hand-off-local-work.mdx
git commit -m "docs(website): broaden handoff to company work"
no-mistakes axi run --yes --intent "Expand AgentOS PR #73 so handoff covers any bounded product or company work, not only coding-agent phases. Show that a company can organize work and decisions around the people with relevant context, expertise, and authority while preserving one accountable owner and exact authority boundaries. Present Flect as an adaptable local workplace today and a truthful future AgentOS front door; a bounded embedded browser or iframe may be an early future adapter, but AgentOS integration and arbitrary embedded-product control are not shipped. Keep the official Flect hero as the only workflow visual, preserve canonical handoff mechanics, validate the full site, update the existing PR, and do not merge."
```

Drive the pipeline until `checks-passed`, list every pipeline-authored fix, and leave PR #73 open for human review.
