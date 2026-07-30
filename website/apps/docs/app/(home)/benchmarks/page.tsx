import Link from 'next/link';
import { ArrowRight, CheckCircle2, CircleOff, Timer, UserRoundCheck } from 'lucide-react';
import { createMetadata } from '@/lib/metadata';

export const metadata = createMetadata({
  title: 'AgentOS benchmarks',
  description:
    'Public evidence for AgentOS outcomes, human attention, recovery, portability and failure.',
  path: '/benchmarks',
});

const metrics = [
  { icon: CheckCircle2, value: '3 of 5', label: 'declared quickstart attempts passed' },
  { icon: Timer, value: '16m 16s', label: 'fastest final accepted delivery' },
  {
    icon: UserRoundCheck,
    value: '0',
    label: 'Captain follow-up turns in the final two passes',
  },
  { icon: CircleOff, value: '1 + 1', label: 'failed and incomplete attempts preserved' },
];

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-8 md:py-24">
      <p className="mb-4 text-xs font-medium tracking-wide text-brand uppercase">Public evidence</p>
      <h1 className="max-w-[900px] text-4xl font-semibold tracking-[-0.04em] text-balance md:text-6xl">
        Measure the organization, not one answer.
      </h1>
      <p className="mt-6 max-w-[760px] text-lg text-pretty text-fd-muted-foreground">
        AgentOS publishes every declared benchmark attempt—including failures—and resolves reported
        results to sanitized evidence with exact subjects, environments and limitations.
      </p>

      <div className="my-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <section key={metric.label} className="rounded-2xl border bg-fd-card p-5">
              <Icon className="mb-6 size-5 text-brand" aria-hidden />
              <p className="text-2xl font-medium">{metric.value}</p>
              <p className="mt-2 text-xs text-fd-muted-foreground">{metric.label}</p>
            </section>
          );
        })}
      </div>

      <section className="rounded-2xl border bg-fd-card p-6 md:p-9">
        <h2 className="mb-4 text-2xl font-medium tracking-tight">
          What the benchmark refuses to hide
        </h2>
        <div className="grid gap-6 text-sm text-fd-muted-foreground md:grid-cols-2">
          <p>
            It records human decisions, clarifications and repair; elapsed time, tools, retries and
            tokens; duplicated work; crash recovery; authority and chain of custody.
          </p>
          <p>
            Missing telemetry stays unknown. Failed and incomplete attempts remain in the series.
            One proven Fleet is not presented as general production maturity.
          </p>
        </div>
        <div className="mt-8 flex flex-wrap gap-4">
          <a
            href="https://github.com/akua-dev/agentos/tree/main/benchmarks/results/agentos"
            className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-3 font-medium text-brand-foreground"
          >
            Inspect published results <ArrowRight className="size-4" aria-hidden />
          </a>
          <Link
            href="/docs/reference/benchmarks"
            className="inline-flex items-center rounded-full border px-5 py-3 font-medium"
          >
            Read the benchmark model
          </Link>
        </div>
      </section>
    </main>
  );
}
