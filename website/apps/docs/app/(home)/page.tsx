import Link from 'next/link';
import { cva } from 'class-variance-authority';
import {
  Activity,
  Anchor,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Eye,
  GitPullRequest,
  Network,
  ShieldCheck,
  TerminalIcon,
  Users,
} from 'lucide-react';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
import { cn } from '@/lib/cn';
import {
  agentOsStructuredData,
  serializeStructuredData,
} from '@/lib/structured-data';
import { Marquee } from '@/app/(home)/marquee';
import { FlectWorkplace } from './flect-workplace';
import { AgnosticBackground, CreateAppAnimation, Hero, Writing } from './page.client';

const headingVariants = cva('font-medium tracking-tight text-balance', {
  variants: {
    variant: {
      h2: 'text-3xl lg:text-4xl',
      h3: 'text-xl lg:text-2xl',
    },
  },
});

const buttonVariants = cva(
  'inline-flex justify-center rounded-full px-5 py-3 font-medium tracking-tight transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-brand-foreground hover:bg-brand-200',
        secondary: 'border bg-fd-secondary text-fd-secondary-foreground hover:bg-fd-accent',
      },
    },
    defaultVariants: { variant: 'primary' },
  },
);

const cardVariants = cva('rounded-2xl p-6 text-sm shadow-lg', {
  variants: {
    variant: {
      secondary: 'bg-brand-secondary text-brand-secondary-foreground',
      default: 'border bg-fd-card',
    },
  },
  defaultVariants: { variant: 'default' },
});

function StaticCodeBlock({
  code,
  codeblock,
}: {
  code: string;
  lang?: string;
  codeblock?: { className?: string; title?: string };
}) {
  return (
    <CodeBlock
      title={codeblock?.title}
      className={codeblock?.className}
      viewportProps={{ className: 'bg-fd-secondary text-fd-secondary-foreground' }}
    >
      <Pre className="font-mono text-xs leading-6">
        <code>{code}</code>
      </Pre>
    </CodeBlock>
  );
}

const principles = [
  {
    name: 'Continuity',
    detail: 'Homes, identity and unfinished work survive disconnects, restarts and lost Pods.',
    icon: Anchor,
  },
  {
    name: 'Responsibility',
    detail: 'Every accepted outcome has one accountable Assignment owner and a path back to people.',
    icon: ShieldCheck,
  },
  {
    name: 'Visibility',
    detail: 'Inspect real terminals, durable state and delivery artifacts—not a green status badge.',
    icon: Eye,
  },
  {
    name: 'Learning',
    detail: 'Evidence becomes reviewed improvement; memory remains fallible context, never authority.',
    icon: Activity,
  },
];

export default function Page() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeStructuredData(agentOsStructuredData),
        }}
      />
      <main className="pt-4 pb-6 text-landing-foreground dark:text-landing-foreground-dark md:pb-12">
      <section className="relative mx-auto flex h-[72vh] max-h-[900px] min-h-[620px] w-full max-w-[1400px] overflow-hidden rounded-2xl border bg-origin-border">
        <Hero />
        <div className="z-2 flex size-full flex-col px-5 py-10 max-md:items-center max-md:text-center md:p-12">
          <p className="mt-6 w-fit rounded-full border border-brand/50 p-2 text-xs font-medium text-brand">
            the open-source company harness.
          </p>
          <h1 className="my-8 max-w-[760px] text-4xl leading-[1.02] font-medium tracking-[-0.04em] text-balance md:text-6xl xl:text-7xl">
            Build autonomous companies, under human <span className="text-brand">control</span>.
          </h1>
          <p className="mb-8 max-w-[660px] text-base text-pretty md:text-lg">
            Turn persistent Agents into an accountable organization with durable work, explicit
            authority and a verifiable path from human intent to delivered evidence.
          </p>
          <div className="flex w-fit flex-wrap items-center justify-center gap-4">
            <Link href="/learn" className={buttonVariants()}>
              Get started
            </Link>
            <a
              href="https://github.com/akua-dev/agentos"
              target="_blank"
              rel="noreferrer noopener"
              className={buttonVariants({ variant: 'secondary' })}
            >
              Open GitHub
            </a>
          </div>
        </div>
      </section>

      <div className="mx-auto mt-12 grid w-full max-w-[1400px] grid-cols-1 gap-10 px-6 md:px-12 lg:mt-20 lg:grid-cols-2">
        <p className="col-span-full text-2xl leading-snug font-light tracking-tight md:text-3xl xl:text-4xl">
          Pi harnesses a model into an <span className="font-medium text-brand">Agent</span>.
          AgentOS harnesses Agents into a{' '}
          <span className="font-medium text-brand">company</span>—without replacing the
          repositories, trackers, infrastructure or human decisions you already trust.
        </p>

        <section className="relative col-span-full overflow-hidden rounded-2xl border bg-fd-card p-4 shadow-lg md:p-8">
          <div className="mx-auto w-full max-w-[920px] rounded-2xl border bg-fd-card p-2 text-fd-card-foreground shadow-lg">
            <div className="flex flex-col gap-2 sm:flex-row">
              <h2 className="content-center rounded-xl border-2 border-brand/50 px-3 py-2 font-mono text-sm font-bold text-brand uppercase">
                One prompt
              </h2>
              <StaticCodeBlock
                code={`Read https://github.com/akua-dev/agentos/blob/main/BOOTSTRAP.md.
Help me bring AgentOS online — check my setup first, ask before changing anything.`}
                lang="text"
                codeblock={{ className: 'flex-1 bg-fd-secondary' }}
              />
            </div>
            <div className="relative mt-2 rounded-xl border bg-fd-secondary shadow-md">
              <div className="flex items-center gap-2 border-b p-2 text-fd-muted-foreground">
                <TerminalIcon className="size-4" />
                <span className="text-xs font-medium">The coding Agent you already use</span>
                <span className="ms-auto me-2 size-2 rounded-full bg-brand" />
              </div>
              <CreateAppAnimation className="p-3 text-fd-secondary-foreground/85" />
            </div>
          </div>
        </section>

        <section className="col-span-full overflow-hidden rounded-2xl bg-brand-secondary text-brand-secondary-foreground">
          <div className="grid lg:grid-cols-[1.05fr_0.95fr]">
            <div className="p-7 md:p-10 lg:p-12">
              <p className="mb-4 font-medium">Work can start wherever thinking is fastest.</p>
              <h2 className="max-w-[18ch] text-3xl leading-[1.04] font-medium tracking-[-0.03em] text-balance md:text-5xl">
                Start anywhere. Bring in the Fleet when the outcome matters.
              </h2>
              <p className="mt-6 max-w-[60ch] text-pretty">
                Shape a UI, sketch backend architecture, research, implement, diagnose, test, or
                conduct a code review locally. Package the desired result and durable evidence,
                then let First Mate turn accepted intent into accountable Fleet work.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/learn/01-first-outcome/hand-off-local-work"
                  className={buttonVariants()}
                >
                  Hand off local work
                </Link>
                <Link
                  href="/docs/operate/continue-local-work"
                  className={buttonVariants({ variant: 'secondary' })}
                >
                  Use the handoff guide
                </Link>
              </div>
            </div>
            <div className="grid border-t border-brand-secondary-foreground/20 bg-brand-secondary-foreground/7 lg:border-t-0 lg:border-l">
              {[
                [
                  'Working evidence',
                  'A UI direction, architecture sketch, research finding, patch or review.',
                ],
                ['Bounded handoff', 'Outcome, evidence, constraints and exact authority boundary.'],
                ['Accountable Fleet work', 'A Task and one active Assignment after acceptance.'],
                ['Reviewed result', 'Delivery evidence returns for your next decision or iteration.'],
              ].map(([title, detail], index) => (
                <div
                  key={title}
                  className="grid grid-cols-[2rem_1fr] gap-4 border-b border-brand-secondary-foreground/20 p-6 last:border-b-0 md:p-7"
                >
                  <span className="grid size-8 place-items-center rounded-full bg-brand-secondary-foreground text-xs font-semibold text-brand-secondary">
                    {index + 1}
                  </span>
                  <div>
                    <h3 className="font-medium">{title}</h3>
                    <p className="mt-1 text-sm opacity-80">{detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <FlectWorkplace />

        <section className={cn(cardVariants(), 'flex flex-col justify-between')}>
          <div>
            <h2 className={cn(headingVariants({ variant: 'h3' }), 'mb-5')}>
              Proof before promises.
            </h2>
            <p className="mb-6">
              AgentOS publishes benchmark attempts—including failures—and links each result to
              sanitized evidence. The question is not whether one demo looked autonomous. It is how
              many verified outcomes the organization delivered for the human attention it used.
            </p>
          </div>
          <a
            href="https://github.com/akua-dev/agentos/tree/main/benchmarks/results/agentos"
            className={cn(buttonVariants(), 'w-fit')}
          >
            Inspect the evidence
          </a>
        </section>

        <section
          aria-label="AgentOS design principles"
          className={cn(cardVariants({ variant: 'secondary' }), 'relative overflow-hidden p-0')}
        >
          <div className="pointer-events-none absolute inset-0 z-2 rounded-2xl inset-shadow-[0_10px_60px] inset-shadow-brand-secondary" />
          <Marquee className="p-8">
            {principles.map((item) => {
              const Icon = item.icon;
              return (
                <article
                  key={item.name}
                  className="flex w-[310px] flex-col rounded-xl border bg-fd-card p-5 text-landing-foreground shadow-lg"
                >
                  <Icon className="mb-7 size-5 text-brand" aria-hidden />
                  <h3 className="mb-2 font-medium">{item.name}</h3>
                  <p className="text-sm text-fd-muted-foreground">{item.detail}</p>
                  <p className="mt-6 text-xs font-medium tracking-wide text-brand uppercase">
                    Design principle
                  </p>
                </article>
              );
            })}
          </Marquee>
        </section>

        <Progression />

        <section
          aria-labelledby="progressive-planning-heading"
          className={cn(cardVariants({ variant: 'secondary' }), 'col-span-full overflow-hidden p-0')}
        >
          <div className="grid gap-px bg-brand-secondary-foreground/15 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
            <div className="bg-brand-secondary p-6 md:p-9">
              <p className="mb-4 font-mono text-xs font-medium tracking-wide uppercase opacity-75">
                Outcome first
              </p>
              <h2
                id="progressive-planning-heading"
                className={cn(headingVariants({ variant: 'h2' }), 'mb-5 max-w-[16ch]')}
              >
                The plan emerges from evidence.
              </h2>
              <p className="mb-8 max-w-[58ch] text-base leading-7">
                You define what should become true, how it will be proven and where authority
                stops. First Mate reads current reality, makes only actionable work durable and
                returns the decisions that still belong to you.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link
                  href="/docs/concepts/progressive-planning"
                  className={buttonVariants()}
                >
                  Understand progressive planning
                </Link>
                <Link
                  href="/learn/01-first-outcome/let-plan-emerge"
                  className={buttonVariants({ variant: 'secondary' })}
                >
                  Try it with a real outcome
                </Link>
              </div>
            </div>

            <div className="bg-brand-secondary p-4 md:p-7">
              <StaticCodeBlock
                lang="text"
                code={`human outcome + authority
  → inspect current reality
      ├─ actionable → Assignment
      ├─ uncertain  → Scout
      ├─ consequential → Captain decision
      └─ prerequisite → dependency
  → evidence
  → next distinct outcome`}
                codeblock={{ title: 'The route stays honest' }}
              />
            </div>
          </div>

          <div className="grid border-t border-brand-secondary-foreground/15 lg:grid-cols-2">
            <article className="border-b border-brand-secondary-foreground/15 p-6 lg:border-r lg:border-b-0 md:p-8">
              <p className="mb-3 font-mono text-xs tracking-wide uppercase opacity-70">
                Predeclared workflow
              </p>
              <h3 className={cn(headingVariants({ variant: 'h3' }), 'mb-4')}>
                The human maintains the graph.
              </h3>
              <p className="leading-7">
                Expected steps become nodes. Unexpected work escapes the model, orchestration owns
                a shadow of state and the human watches execution.
              </p>
            </article>
            <article className="p-6 md:p-8">
              <p className="mb-3 font-mono text-xs tracking-wide uppercase opacity-70">AgentOS</p>
              <h3 className={cn(headingVariants({ variant: 'h3' }), 'mb-4')}>
                The organization maintains responsibility.
              </h3>
              <p className="leading-7">
                Agents reason from authoritative reality. New evidence can become owned work while
                native systems keep the facts and people keep consequential authority.
              </p>
            </article>
          </div>
        </section>

        <h2
          className={cn(
            headingVariants({ variant: 'h2' }),
            'col-span-full mt-8 mb-4 text-center text-brand',
          )}
        >
          Native systems. One accountable organization.
        </h2>

        <section className={cn(cardVariants(), 'col-span-full overflow-hidden p-0')}>
          <div className="grid md:grid-cols-5">
            {[
              ['Tracker', 'Human planning and provider workflow.'],
              ['PostgreSQL', 'Durable Tasks, Assignments and decisions.'],
              ['Kubernetes', 'Live workloads and persistent homes.'],
              ['Herdr', 'Inspectable native harness sessions.'],
              ['Git', 'Delivered source and review artifacts.'],
            ].map(([name, description]) => (
              <div
                key={name}
                className="border-b p-5 last:border-b-0 md:border-r md:border-b-0 md:last:border-r-0"
              >
                <p className="mb-2 font-medium text-brand">{name}</p>
                <p className="text-xs text-fd-muted-foreground">{description}</p>
              </div>
            ))}
          </div>
        </section>

        <section className={cn(cardVariants(), 'relative flex min-h-[420px] flex-col overflow-hidden')}>
          <AgnosticBackground />
          <Network className="mb-8 size-6 text-brand" aria-hidden />
          <h3 className={cn(headingVariants({ variant: 'h3' }), 'mb-5')}>
            Connect authorities. Do not mirror them.
          </h3>
          <p className="mb-8 max-w-[52ch]">
            AgentOS coordinates across native systems without hiding them behind a universal wrapper
            or shadow database. The authority for each consequence stays where it belongs.
          </p>
          <div className="mt-auto space-y-2">
            {[
              ['Human intent', 'Tracker'],
              ['Accountable owner', 'PostgreSQL'],
              ['Running work', 'Kubernetes + Herdr'],
              ['Delivered result', 'Git + provider'],
            ].map(([concern, authority]) => (
              <div
                key={concern}
                className="flex items-center justify-between gap-4 border-b border-dashed py-2 text-xs"
              >
                <span>{concern}</span>
                <span className="font-medium text-brand">{authority}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={cn(cardVariants(), 'flex flex-col')}>
          <Users className="mb-8 size-6 text-brand" aria-hidden />
          <h3 className={cn(headingVariants({ variant: 'h3' }), 'mb-5')}>
            A crew, not a swarm.
          </h3>
          <p className="mb-7">
            Captain is a role a person or team can hold. First Mate turns its intent into owned
            work. Second Mates lead durable domains. Crewmates deliver bounded outcomes. Humans use
            one company surface; internal routing stays the company&apos;s problem.
          </p>
          <div className="mt-auto rounded-xl border bg-fd-secondary p-4 font-mono text-xs leading-6">
            Captain → First Mate → Second Mate → Crewmate
            <br />
            <span className="text-fd-muted-foreground">
              one direct supervision edge · one accountable owner
            </span>
          </div>
        </section>

        <section className={cn(cardVariants(), 'col-span-full')}>
          <div className="grid gap-8 lg:grid-cols-[1fr_1.15fr] lg:items-center">
            <div>
              <CheckCircle2 className="mb-7 size-6 text-brand" aria-hidden />
              <h2 className={cn(headingVariants({ variant: 'h2' }), 'mb-5')}>
                Intent has a chain of custody.
              </h2>
              <p className="max-w-[56ch]">
                A Task preserves accepted intent. An Assignment binds the active outcome to one
                accountable Agent. Handoffs keep history. Evidence closes the loop; a status label
                alone does not.
              </p>
            </div>
            <StaticCodeBlock
              lang="text"
              code={`Human intent
  → Task
  → Assignment
  → accountable Agent
  → verified result`}
              codeblock={{ title: 'Chain of custody' }}
            />
          </div>
        </section>

        <section className={cn(cardVariants(), 'flex flex-col')}>
          <Boxes className="mb-8 size-6 text-brand" aria-hidden />
          <h3 className={cn(headingVariants({ variant: 'h3' }), 'mb-5')}>
            Start with one real project.
          </h3>
          <p className="mb-8">
            Your repository, issues, board and CI stay where they are. The Fleet delivers ordinary
            pull requests through the workflow that project already trusts. Authority grows only
            through standing rules people deliberately record.
          </p>
          <Link href="/docs/start/adopt-project" className={cn(buttonVariants(), 'mt-auto w-fit')}>
            Adopt a project
          </Link>
        </section>

        <section className={cn(cardVariants({ variant: 'secondary' }), 'flex flex-col')}>
          <GitPullRequest className="mb-8 size-6" aria-hidden />
          <h3 className={cn(headingVariants({ variant: 'h3' }), 'mb-5')}>
            Early, open and inspectable.
          </h3>
          <p className="mb-8">
            AgentOS is early. It does not ask one successful Fleet to stand in for general
            production maturity. Every release names its support boundary, and every improvement is
            expected to begin with evidence.
          </p>
          <Link href="/docs/reference/benchmarks" className={cn(buttonVariants(), 'mt-auto w-fit')}>
            How evaluation works
          </Link>
        </section>

        <section className="col-span-full my-16 rounded-2xl border bg-fd-card p-8 text-center shadow-lg md:p-14">
          <h2 className="mx-auto mb-5 max-w-[760px] text-3xl font-medium tracking-tight text-balance text-brand md:text-5xl">
            Stop being the loop. Stay at the helm.
          </h2>
          <p className="mx-auto mb-8 max-w-[680px] text-pretty">
            Bring AgentOS online, give the Fleet a real outcome and learn each new layer as your
            company starts to work.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link href="/learn" className={buttonVariants()}>
              Get started
            </Link>
            <Link href="/docs" className={buttonVariants({ variant: 'secondary' })}>
              Open documentation
            </Link>
            <a
              href="https://github.com/akua-dev/agentos/blob/main/CONTRIBUTING.md"
              className={buttonVariants({ variant: 'secondary' })}
            >
              Contribute
            </a>
          </div>
        </section>
      </div>
      </main>
    </>
  );
}

function Progression() {
  return (
    <Writing
      tabs={{
        chatbot: (
          <div className="grid gap-8 rounded-2xl border bg-fd-card p-6 shadow-lg lg:grid-cols-2">
            <StaticCodeBlock
              lang="text"
              code={`Model → generation
Chat → turns + context
Copilot → retrieval + instructions

Human still carries the goal.`}
            />
            <div>
              <h3 className={cn(headingVariants({ variant: 'h3' }), 'my-4')}>
                Assistance is not delegation.
              </h3>
              <p>
                A model generates. Chat makes generation conversational. A copilot enters the
                workflow with retrieval and integrations. Each can be enormously useful, but the
                human still preserves continuity and decides every next step.
              </p>
              <Link
                href="/learn/01-first-outcome/bring-agentos-online"
                className="mt-7 inline-flex items-center gap-2 font-medium text-brand hover:underline"
              >
                Bring AgentOS online <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
        ),
        agent: (
          <div className="grid gap-8 rounded-2xl border bg-fd-card p-6 shadow-lg lg:grid-cols-2">
            <StaticCodeBlock
              lang="text"
              code={`bounded outcome
  → reason
  → act with tools
  → observe reality
  → adjust
  → return evidence`}
            />
            <div>
              <h3 className={cn(headingVariants({ variant: 'h3' }), 'my-4')}>
                An Agent owns a bounded outcome.
              </h3>
              <p>
                The delegation threshold arrives when the system can carry a goal through a
                reason–act–observe loop. A harness supplies its session, context, Skills, memory,
                sandbox, permissions and recovery.
              </p>
              <Link
                href="/learn/01-first-outcome/give-fleet-outcome"
                className="mt-7 inline-flex items-center gap-2 font-medium text-brand hover:underline"
              >
                Give the Fleet an outcome <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
        ),
        company: (
          <div className="grid gap-8 rounded-2xl border bg-fd-card p-6 shadow-lg lg:grid-cols-2">
            <StaticCodeBlock
              lang="text"
              code={`Agent team + durable organization

identity · ownership · hierarchy
authority · attention · recovery

= autonomous company`}
            />
            <div>
              <h3 className={cn(headingVariants({ variant: 'h3' }), 'my-4')}>
                Parallel Agents are not yet a company.
              </h3>
              <p>
                Routing sessions can increase throughput. AgentOS adds what makes that activity an
                accountable organization: persistent identity, durable work, explicit authority,
                supervision, human attention and recovery.
              </p>
              <Link
                href="/learn/02-grow-company/add-durable-domain"
                className="mt-7 inline-flex items-center gap-2 font-medium text-brand hover:underline"
              >
                Add a durable domain <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
        ),
      }}
    />
  );
}
