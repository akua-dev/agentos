# Local-agent handoff and Flect workplace implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local-to-Fleet handoff and adaptive Flect work surfaces obvious across the AgentOS landing page, Learn, docs, and a shorter README funnel.

**Architecture:** Keep operating truth in one handoff guide and interface boundaries in one concept page. Add an isolated client-side Flect concept component with a CSS module for accessible scenario switching and restrained motion; the server landing page only composes it and the local-handoff story. Existing Learn and Docs contracts remain the route/navigation authorities.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, CSS Modules, Fumadocs MDX, Vitest, Testing Library, Bun.

## Global Constraints

- AgentOS remains the authority for Tasks, Assignments, Inbox decisions, authority, and durable evidence; the interface remains a replaceable surface.
- Flect is a public developer preview and natural dogfooding adopter, not a bundled AgentOS dependency or shipped AgentOS integration.
- Label the visual `AgentOS × Flect concept`; do not claim current integration behavior.
- Add no CLI, API, webhook receiver, database mechanic, Skill, agent instruction, animation dependency, autoplay video, or cross-origin runtime media.
- A local transcript is context, an external event is evidence, and accepted execution starts only with an accountable Assignment.
- Preserve the exact bootstrap prompt, benchmark headline, source links, contribution path, and licenses.
- Reduce `README.md` from 228 lines to at most 159 lines.
- Essential content must render without JavaScript. Disable non-essential movement under `prefers-reduced-motion: reduce`.
- Use native interactive semantics, meaningful names, keyboard access, and visible focus.

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
- Create: `website/apps/docs/app/(home)/flect-workplace.tsx`
- Create: `website/apps/docs/app/(home)/flect-workplace.module.css`
- Modify: `website/apps/docs/app/(home)/page.tsx`

**Interfaces:**
- Produces: `FlectWorkplace(): ReactElement`.
- Produces scenario controls named `Product decision`, `Incident response`, and `Research review`.
- Produces canonical Learn, operating-guide, work-surface, and Flect links.

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

- [ ] **Step 2: Write the failing Flect interaction test**

Create `flect-workplace.test.tsx` with Testing Library and `userEvent`:

```tsx
it('adapts the decision view while preserving the human approval path', async () => {
  const user = userEvent.setup();
  render(<FlectWorkplace />);

  expect(screen.getByRole('heading', { name: 'Approve the launch scope' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Incident response' }));
  expect(screen.getByRole('heading', { name: 'Choose the recovery path' })).toBeVisible();
  expect(screen.getByText('Human approval')).toBeVisible();
  expect(screen.getByText('First Mate')).toBeVisible();
  expect(screen.getByText('Durable Fleet work')).toBeVisible();
});
```

- [ ] **Step 3: Verify RED**

Run:

```console
bun run --cwd website/apps/docs test components/landing-page.test.tsx components/flect-workplace.test.tsx
```

Expected: FAIL because the component, links, and scenario controls are missing.

- [ ] **Step 4: Implement the Flect component**

Use this data contract in `flect-workplace.tsx`:

```tsx
const previews = [
  {
    id: 'product',
    label: 'Product decision',
    title: 'Approve the launch scope',
    summary: 'The release is ready. One reliability tradeoff still belongs to you.',
    signal: '2 reviewed changes · 1 open decision',
    evidence: ['Checkout errors down 38%', 'Rollback rehearsed', 'EU rollout still excluded'],
    draft: 'Keep the smaller rollout. Ask First Mate to schedule the EU follow-up.',
  },
  {
    id: 'incident',
    label: 'Incident response',
    title: 'Choose the recovery path',
    summary: 'The Fleet contained the failure. Recovery speed now trades against data certainty.',
    signal: 'Service stable · decision due in 14 min',
    evidence: ['Writes are paused', 'Replica is healthy', 'Backfill needs review'],
    draft: 'Restore reads now. Keep writes paused until the backfill report is reviewed.',
  },
  {
    id: 'research',
    label: 'Research review',
    title: 'Select the next bet',
    summary: 'Three investigations returned evidence. The strategic choice remains human.',
    signal: '3 reports reconciled · no execution accepted',
    evidence: ['Option A: fastest proof', 'Option B: strongest moat', 'Option C: lowest cost'],
    draft: 'Fund a bounded Option B prototype and keep Option A as the fallback.',
  },
] as const;
```

Render:

1. A dark `AgentOS × Flect concept` section headed `The interface to your AgentOS company.`.
2. Native scenario buttons using `aria-pressed`.
3. An `aria-live="polite"` decision panel with evidence and a feedback draft.
4. An ordered chain: `Prepared for you → Human approval → First Mate → Durable Fleet work`.
5. A second section headed `Flect works beyond AgentOS.` with `Start with AgentOS` and `Start with Flect`.
6. Links named `Design a human work surface`, `See Flect shape`, and `Explore Flect`; use `https://github.com/akua-dev/flect#see-it-shape` for the real demo.

- [ ] **Step 5: Add scoped art direction and motion**

In the CSS module, use Flect's documented Midnight Drafting Desk tokens:

```css
.story {
  --flect-void: oklch(0.095 0 0);
  --flect-canvas: oklch(0.125 0.004 340);
  --flect-surface: oklch(0.165 0.006 340);
  --flect-raised: oklch(0.205 0.008 340);
  --flect-ink: oklch(0.955 0.006 340);
  --flect-muted: oklch(0.69 0.012 340);
  --flect-line: oklch(0.3 0.01 340);
  --flect-rose: oklch(0.63 0.18 340);
  color: var(--flect-ink);
  background: var(--flect-void);
  border-radius: 16px;
}

.panel {
  animation: surface-arrives 480ms cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes surface-arrives {
  from { opacity: 0; transform: translateY(10px); clip-path: inset(0 0 12% 0); }
  to { opacity: 1; transform: translateY(0); clip-path: inset(0); }
}

@media (prefers-reduced-motion: reduce) {
  .panel,
  .signal,
  .handoffPulse { animation: none; }
}
```

Complete a 12-column desktop surface and stacked mobile surface. Use visible focus rings, no essential color-only state, no radius above 16px, and no border-plus-wide-shadow decoration.

- [ ] **Step 6: Compose the landing stories**

Immediately after the bootstrap demo, add a full-width local-handoff section:

```text
Start where you think fastest. Hand off when the outcome matters.
Plan · Prototype · Diagnose · Partially implement
Local evidence → bounded handoff → accountable Fleet work → reviewed result
```

Add links `Hand off local work` and `Use the handoff guide`, then render `<FlectWorkplace />` before `Proof before promises.`.

- [ ] **Step 7: Verify GREEN and commit**

Run the focused tests, then:

```console
git add website/apps/docs/app/\(home\) website/apps/docs/components/landing-page.test.tsx website/apps/docs/components/flect-workplace.test.tsx
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
- `Hand off the outcome, not the transcript`: one diagnosis using the five-part package.
- `Let First Mate accept responsibility`: evidence/event versus Task/Assignment.
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

Run `bun run site:dev` and inspect with `chrome-devtools-axi` near 1440 px and 390 px. Verify all scenarios, keyboard focus, heading hierarchy, contrast, reduced motion, overflow, and every new internal/external destination.

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
no-mistakes axi run --intent "Make AgentOS's local-to-Fleet handoff recognizable across the landing page, Learn, canonical docs, and a README reduced by at least 30% into a website funnel. Give Flect one immersive adaptive-workplace section and one broader-platform section using an accessible native web animation that shows personalized decisions, agent-assisted revision, human approval, and handoff to First Mate. Present Flect accurately as a public developer preview and natural first AgentOS dogfooding adopter, while making clear the AgentOS integration is a concept, Flect works beyond AgentOS, and AgentOS remains durable authority. Add no new runtime or intake mechanism and do not merge."
```

- [ ] **Step 2: Drive gates**

Approve no-op findings, authorize low-risk auto-fixes through `axi respond --action fix`, and stop for Robin on any `ask-user` finding. Never edit directly while the run is active.

- [ ] **Step 3: Stop at `checks-passed`**

Report the PR URL, required checks, findings, and every pipeline fix. Do not merge.
