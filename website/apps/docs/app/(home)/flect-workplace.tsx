'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import styles from './flect-workplace.module.css';

const previews = [
  {
    id: 'product',
    label: 'Product decision',
    title: 'Approve the launch scope',
    summary: 'The release is ready. One reliability tradeoff still belongs to you.',
    signal: '2 reviewed changes · 1 open decision',
    evidence: ['Checkout errors down 38%', 'Rollback rehearsed', 'EU rollout still excluded'],
    draft: 'Keep the smaller rollout. Ask First Mate to schedule the EU follow-up.',
    agentNote:
      'I pulled the latest delivery evidence and separated the unresolved choice from the work already reviewed.',
  },
  {
    id: 'incident',
    label: 'Incident response',
    title: 'Choose the recovery path',
    summary: 'The Fleet contained the failure. Recovery speed now trades against data certainty.',
    signal: 'Service stable · decision due in 14 min',
    evidence: ['Writes are paused', 'Replica is healthy', 'Backfill needs review'],
    draft: 'Restore reads now. Keep writes paused until the backfill report is reviewed.',
    agentNote:
      'I condensed the incident timeline and kept the irreversible write decision outside the draft.',
  },
  {
    id: 'research',
    label: 'Research review',
    title: 'Select the next bet',
    summary: 'Three investigations returned evidence. The strategic choice remains human.',
    signal: '3 reports reconciled · no execution accepted',
    evidence: ['Option A: fastest proof', 'Option B: strongest moat', 'Option C: lowest cost'],
    draft: 'Fund a bounded Option B prototype and keep Option A as the fallback.',
    agentNote:
      'I aligned the three reports to the same decision criteria without turning a recommendation into accepted work.',
  },
] as const;

const handoffStages = ['Prepared for you', 'Human approval', 'First Mate', 'Durable Fleet work'];

export function FlectWorkplace() {
  const [activeId, setActiveId] = useState<(typeof previews)[number]['id']>('product');
  const active = previews.find((preview) => preview.id === activeId) ?? previews[0];

  return (
    <>
      <section className={`col-span-full ${styles.story}`} aria-labelledby="flect-workplace-title">
        <div className={styles.storyHeader}>
          <div>
            <p className={styles.conceptLabel}>AgentOS × Flect concept</p>
            <h2 id="flect-workplace-title">The interface to your AgentOS company.</h2>
            <p className={styles.introduction}>
              Decisions arrive with the context that matters to you. The surface changes to fit the
              choice; the accountable company underneath does not.
            </p>
          </div>
          <p className={styles.previewStatus}>
            <span className={styles.statusDot} aria-hidden />
            Flect public developer preview
          </p>
        </div>

        <div className={styles.scenarioControls} role="group" aria-label="Preview a decision workspace">
          {previews.map((preview) => (
            <button
              key={preview.id}
              type="button"
              aria-pressed={preview.id === activeId}
              onClick={() => setActiveId(preview.id)}
            >
              {preview.label}
            </button>
          ))}
        </div>

        <div className={styles.workspace}>
          <aside className={styles.attention} aria-label="Prepared attention queue">
            <p className={styles.surfaceLabel}>Your attention</p>
            <p className={styles.queueSummary}>Three decisions, already lined up.</p>
            <ol>
              {previews.map((preview) => (
                <li key={preview.id} data-active={preview.id === activeId}>
                  <span aria-hidden />
                  <div>
                    <strong>{preview.label}</strong>
                    <small>{preview.id === activeId ? 'Open now' : 'Prepared'}</small>
                  </div>
                </li>
              ))}
            </ol>
          </aside>

          <article key={active.id} className={styles.panel} aria-live="polite">
            <div className={styles.panelHeading}>
              <p className={styles.surfaceLabel}>Prepared decision</p>
              <p className={styles.signal}>
                <span aria-hidden />
                {active.signal}
              </p>
            </div>
            <h3>{active.title}</h3>
            <p className={styles.summary}>{active.summary}</p>

            <div className={styles.evidenceBlock}>
              <p className={styles.surfaceLabel}>Evidence in view</p>
              <ul>
                {active.evidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>

            <div className={styles.draft}>
              <p className={styles.surfaceLabel}>Your draft feedback</p>
              <p>{active.draft}</p>
            </div>
          </article>

          <aside className={styles.agentRail} aria-label="Built-in agent workspace">
            <div className={styles.agentIdentity}>
              <span aria-hidden>f</span>
              <div>
                <strong>Built-in agent</strong>
                <small>Working locally with approved context</small>
              </div>
            </div>
            <p>{active.agentNote}</p>
            <div className={styles.agentCapabilities}>
              <span>Revise the draft</span>
              <span>Ask First Mate</span>
            </div>
            <p className={styles.authorityNote}>
              Nothing consequential moves until you approve it.
            </p>
          </aside>
        </div>

        <ol className={styles.handoff} aria-label="From prepared decision to accountable work">
          {handoffStages.map((stage, index) => (
            <li key={stage}>
              <span aria-hidden>{index + 1}</span>
              {stage}
            </li>
          ))}
        </ol>

        <div className={styles.storyLinks}>
          <Link href="/docs/concepts/human-work-surfaces">
            Design a human work surface <ArrowRight aria-hidden />
          </Link>
          <a href="https://github.com/akua-dev/flect" target="_blank" rel="noreferrer noopener">
            Explore Flect <ArrowUpRight aria-hidden />
          </a>
        </div>
      </section>

      <section
        className="col-span-full overflow-hidden rounded-2xl border bg-fd-card text-fd-card-foreground shadow-lg"
        aria-labelledby="flect-beyond-title"
      >
        <div className="grid lg:grid-cols-[1.05fr_1fr]">
          <div className="p-7 md:p-10 lg:p-12">
            <p className="mb-4 font-medium text-brand">One interface shell. More than one product.</p>
            <h2
              id="flect-beyond-title"
              className="mb-5 max-w-[16ch] text-3xl font-medium tracking-[-0.03em] text-balance md:text-5xl"
            >
              Flect works beyond AgentOS.
            </h2>
            <p className="max-w-[62ch] text-pretty">
              AgentOS is a natural first dogfooding adopter: it has real agents, work, decisions and
              history that deserve a thoughtful human surface. Flect stays open and general enough
              to become the interface layer for a different product, API or personal workplace.
            </p>
            <a
              href="https://github.com/akua-dev/flect#see-it-shape"
              target="_blank"
              rel="noreferrer noopener"
              className="mt-8 inline-flex items-center gap-2 font-medium text-brand hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand"
            >
              See Flect shape <ArrowUpRight className="size-4" aria-hidden />
            </a>
          </div>
          <div className="grid border-t lg:border-t-0 lg:border-l">
            <div className="p-7 md:p-9">
              <p className="mb-2 text-sm font-medium text-brand">Start with AgentOS</p>
              <h3 className="mb-3 text-xl font-medium">Keep the default. Shape what you need.</h3>
              <p className="text-sm text-fd-muted-foreground">
                A company can offer one excellent workplace while each employee adapts how their
                own context and decisions appear.
              </p>
            </div>
            <div className="border-t p-7 md:p-9">
              <p className="mb-2 text-sm font-medium text-brand">Start with Flect</p>
              <h3 className="mb-3 text-xl font-medium">Bring another product or build locally.</h3>
              <p className="text-sm text-fd-muted-foreground">
                The same shell can expose approved capabilities from a service or begin as a useful
                personal interface without AgentOS.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
