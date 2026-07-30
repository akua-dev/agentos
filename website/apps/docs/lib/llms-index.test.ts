import { describe, expect, it } from 'vitest';

describe('AgentOS language-model index', () => {
  it('publishes only absolute site links and exposes the full text bundle', async () => {
    const { renderLlmsIndex } = await import('./llms-index');
    const text = renderLlmsIndex({
      documentation: [
        {
          url: '/docs/start/get-started',
          data: {
            title: 'Get started',
            description: 'Bring AgentOS online.',
          },
        },
      ],
      learn: [
        {
          url: '/learn/01-first-outcome/bring-agentos-online',
          data: {
            title: 'Bring AgentOS online',
            description: 'Start the first Fleet.',
          },
        },
      ],
    });

    expect(text).toContain(
      '[Full AgentOS text](https://agentos.akua.dev/llms-full.txt)',
    );
    expect(text).toContain(
      '[Get started](https://agentos.akua.dev/docs/start/get-started)',
    );
    expect(text).toContain(
      '[Benchmarks](https://agentos.akua.dev/benchmarks)',
    );
    expect(text).not.toMatch(/\]\(\//);
  });
});
