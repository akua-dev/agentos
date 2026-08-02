// @vitest-environment jsdom

import { assert, describe, it } from '@effect/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Effect, Schema } from 'effect';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import Page from '@/app/(home)/page';

vi.mock('@/app/(home)/marquee', () => ({
  Marquee: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/app/(home)/page.client', () => ({
  AgnosticBackground: () => null,
  CreateAppAnimation: () => null,
  Hero: () => null,
  Writing: () => null,
}));

vi.mock('@/app/(home)/flect-workplace', () => ({
  FlectWorkplace: () => (
    <section>
      <a href="/docs/concepts/human-work-surfaces">See how the workplace works</a>
      <a href="https://github.com/akua-dev/flect">Explore Flect</a>
    </section>
  ),
}));

const StructuredData = Schema.Struct({
  '@context': Schema.Literal('https://schema.org'),
  '@graph': Schema.Array(
    Schema.Struct({
      '@type': Schema.String,
      name: Schema.optional(Schema.String),
      codeRepository: Schema.optional(Schema.String),
    }),
  ),
});

const renderPage = Effect.acquireRelease(
  Effect.sync(() => render(<Page />)),
  () => Effect.sync(cleanup),
);

describe('landing page', () => {
  it.effect('uses Learn as the primary get-started destination', () =>
    Effect.gen(function* () {
      yield* renderPage;
      const getStartedLinks = screen.getAllByRole('link', { name: 'Get started' });
      assert.lengthOf(getStartedLinks, 2);
      assert.deepStrictEqual(
        getStartedLinks.map((link) => link.getAttribute('href')),
        ['/learn', '/learn'],
      );
    }));

  it.effect('routes local work and adaptive workplaces to their canonical guides', () =>
    Effect.gen(function* () {
      yield* renderPage;
      assert.strictEqual(
        screen.getByRole('link', { name: 'Hand off local work' }).getAttribute('href'),
        '/learn/01-first-outcome/hand-off-local-work',
      );
      assert.strictEqual(
        screen.getByRole('link', { name: 'Use the handoff guide' }).getAttribute('href'),
        '/docs/operate/continue-local-work',
      );
      assert.strictEqual(
        screen
          .getByRole('link', { name: 'See how the workplace works' })
          .getAttribute('href'),
        '/docs/concepts/human-work-surfaces',
      );
      assert.strictEqual(
        screen.getByRole('link', { name: 'Explore Flect' }).getAttribute('href'),
        'https://github.com/akua-dev/flect',
      );
    }));

  it.effect('presents handoff as a boundary for any product or company work', () =>
    Effect.gen(function* () {
      yield* renderPage;
      assert.isNotNull(
        screen.getByRole('heading', {
          name: 'Start anywhere. Bring in the Fleet when the outcome matters.',
        }),
      );
      assert.isNotNull(screen.getByText(/UI direction/));
      assert.isNotNull(screen.getByText(/backend architecture/));
      assert.isNotNull(screen.getByText(/code review/));
    }));

  it.effect('renders the canonical AgentOS structured-data graph', () =>
    Effect.gen(function* () {
      const rendered = yield* renderPage;
      const script = rendered.container.querySelector('script[type="application/ld+json"]');
      assert.isNotNull(script);
      const graph = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(StructuredData),
      )(script?.textContent ?? '');
      assert.strictEqual(graph['@context'], 'https://schema.org');
      assert.deepInclude(graph['@graph'][0] ?? {}, {
        '@type': 'WebSite',
        name: 'AgentOS',
      });
      assert.deepInclude(graph['@graph'][1] ?? {}, {
        '@type': 'SoftwareSourceCode',
        codeRepository: 'https://github.com/akua-dev/agentos',
      });
    }));

  it.effect('connects progressive planning to its explanation and hands-on lesson', () =>
    Effect.gen(function* () {
      yield* renderPage;
      assert.ok(
        screen.getByRole('heading', { name: 'The plan emerges from evidence.' }),
      );
      assert.strictEqual(
        screen
          .getByRole('link', { name: 'Understand progressive planning' })
          .getAttribute('href'),
        '/docs/concepts/progressive-planning',
      );
      assert.strictEqual(
        screen.getByRole('link', { name: 'Try it with a real outcome' }).getAttribute('href'),
        '/learn/01-first-outcome/let-plan-emerge',
      );
    }));
});
