import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

const progression: ReadonlyArray<readonly [string, string]> = [
  ['Model', 'generates'],
  ['Chat', 'carries context'],
  ['Tools', 'create effects'],
  ['Agent', 'owns an outcome'],
  ['Harness', 'preserves work'],
  ['Crew', 'coordinates'],
  ['Autonomous company', 'operates and learns'],
];

const outcomes: ReadonlyArray<string> = [
  'A persistent First Mate and one real outcome with durable ownership.',
  'A bounded crew you can inspect and steer through native project artifacts.',
  'Human decisions routed to the right people only when consequences require them.',
  'External signals, shared learning and recovery that survive individual sessions.',
  'An upgradeable, sovereign foundation built from Kubernetes, PostgreSQL and Git.',
];

export function CourseIntroduction({ firstLessonUrl }: { firstLessonUrl: string }) {
  return (
    <article className="mx-auto max-w-[704px]">
      <header className="border-b pb-8">
        <p className="mb-4 font-mono text-xs font-medium text-brand">AgentOS Learn · Introduction</p>
        <h1 className="max-w-[19ch] text-[clamp(2.25rem,4vw,3.5rem)] leading-[1.02] font-semibold tracking-[-0.04em] text-balance">
          What is an autonomous company?
        </h1>
        <p className="mt-6 max-w-[62ch] text-base leading-7 text-pretty text-fd-muted-foreground sm:text-lg sm:leading-8">
          An autonomous company is a human-led organization in which persistent Agents turn intent
          into owned outcomes, operate within explicit authority, learn from evidence and return the
          decisions that belong to people.
        </p>
      </header>

      <section id="first-win" className="scroll-mt-24 py-10">
        <div className="rounded-xl border border-brand/25 bg-brand/5 p-5 sm:p-6">
          <p className="font-mono text-xs font-medium tracking-wide text-brand uppercase">
            Start here
          </p>
          <h2 className="mt-3 text-2xl font-semibold tracking-[-0.025em] text-balance">
            Get a working Fleet first
          </h2>
          <p className="mt-4 max-w-[60ch] leading-7 text-fd-foreground/90">
            Your first useful win is not memorizing every layer below. Start the reviewed
            bootstrap with the coding Agent you already use. While it checks your environment and
            asks for the approvals that matter, continue through the course with a real system to
            connect each concept to.
          </p>
          <p className="mt-3 max-w-[60ch] text-sm leading-6 text-fd-muted-foreground">
            The first six chapters take you from installation to one review-ready outcome. The
            remaining five teach you to grow and upgrade that working company without losing
            control.
          </p>
          <Link
            href={firstLessonUrl}
            className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-full bg-brand px-5 py-2.5 font-medium text-brand-foreground transition-colors hover:bg-brand-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            Bring AgentOS online
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </section>

      <section id="outcome" className="scroll-mt-24 pb-10">
        <h2 className="text-2xl font-semibold tracking-[-0.025em] text-balance">
          What you will be able to run
        </h2>
        <p className="mt-3 max-w-[62ch] leading-7 text-fd-muted-foreground">
          By the end, you will have a path from one working Fleet to a real organization—not a
          collection of disconnected chats.
        </p>
        <ul className="mt-6 border-t">
          {outcomes.map((outcome) => (
            <li key={outcome} className="grid grid-cols-[20px_1fr] gap-3 border-b py-3.5 text-sm">
              <span className="font-mono text-brand" aria-hidden>
                +
              </span>
              <span className="leading-6">{outcome}</span>
            </li>
          ))}
        </ul>
      </section>

      <section id="what-makes-it-a-company" className="scroll-mt-24 border-t py-10">
        <h2 className="text-2xl font-semibold tracking-[-0.025em] text-balance">
          An Agent is not yet a company
        </h2>
        <div className="mt-4 space-y-4 leading-7 text-fd-foreground/90">
          <p>
            A model can produce a plan. Tools let it change the world. A harness can preserve its
            session and unfinished work. None of those layers alone creates an organization.
          </p>
          <p>
            A company also needs durable ownership, a chain of responsibility, shared truth,
            recovery, memory and a deliberate way to spend human attention. AgentOS supplies that
            organizational layer while leaving judgment in the model and consequences with the
            people who own them.
          </p>
        </div>
      </section>

      <section id="progression" className="scroll-mt-24 pb-10">
        <h2 className="text-2xl font-semibold tracking-[-0.025em] text-balance">
          From one answer to a company
        </h2>
        <p className="mt-3 max-w-[62ch] leading-7 text-fd-muted-foreground">
          This is the mental map, not a prerequisite list. The course introduces each layer only
          when your working Fleet needs it.
        </p>
        <ol
          aria-label="Progression from model to autonomous company"
          className="relative mt-6"
        >
          {progression.map(([label, description], index) => {
            const isFirst = index === 0;
            const isFinal = index === progression.length - 1;

            return (
              <li
                key={label}
                className={`relative flex min-h-16 ${isFinal ? 'rounded-lg bg-brand/10' : ''}`}
              >
                <span
                  className={`absolute left-4 w-px bg-fd-border ${
                    isFirst ? 'top-8 bottom-0' : isFinal ? 'top-0 bottom-8' : 'inset-y-0'
                  }`}
                  aria-hidden
                />
                <div className="relative z-10 flex w-12 shrink-0 items-center">
                  <span
                    className={`flex size-8 items-center justify-center rounded-full border font-mono text-[10px] ${
                      isFinal
                        ? 'border-brand bg-brand font-semibold text-brand-foreground'
                        : 'bg-fd-background text-brand'
                    }`}
                    aria-hidden
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                </div>
                <div
                  className={`flex min-w-0 flex-1 flex-col justify-center gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6 ${
                    isFinal ? 'py-4 pr-4' : 'border-b py-3'
                  }`}
                >
                  <strong
                    className={`text-base ${
                      isFinal ? 'font-semibold text-brand' : 'font-medium'
                    }`}
                  >
                    {label}
                  </strong>
                  <span
                    className={`text-sm leading-5 ${
                      isFinal
                        ? 'font-medium text-fd-foreground'
                        : 'text-fd-muted-foreground'
                    }`}
                  >
                    {description}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section id="how-to-use-course" className="scroll-mt-24 border-t pt-8">
        <h2 className="text-2xl font-semibold tracking-[-0.025em] text-balance">
          Build first. Learn each layer when it becomes useful.
        </h2>
        <p className="mt-4 leading-7 text-fd-foreground/90">
          Eleven short chapters form one path: run the first outcome, grow it into a company, then
          upgrade it without surrendering control. Learn explains why each layer exists;{' '}
          <Link href="/docs" className="font-medium text-brand hover:underline">
            Documentation
          </Link>{' '}
          owns the technical reference, current commands and operating boundaries.
        </p>
        <Link
          href={firstLessonUrl}
          className="mt-8 inline-flex min-h-11 items-center gap-2 rounded-full bg-brand px-5 py-2.5 font-medium text-brand-foreground transition-colors hover:bg-brand-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          Start the first chapter
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </section>
    </article>
  );
}
