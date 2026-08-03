import { assert, describe, it } from '@effect/vitest';

import { renderLlmsIndex } from './llms-index';

describe('AgentOS language-model index', () => {
  it('publishes only absolute site links and exposes the full text bundle', () => {
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

    assert.include(text, '[Full AgentOS text](https://agentos.akua.dev/llms-full.txt)');
    assert.include(text, '[Get started](https://agentos.akua.dev/docs/start/get-started)');
    assert.include(text, '[Benchmarks](https://agentos.akua.dev/benchmarks)');
    assert.notMatch(text, /\]\(\//);
  });
});
