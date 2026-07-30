import { describe, expect, it } from 'vitest';
import { agentOsStructuredData, serializeStructuredData } from './structured-data';

describe('AgentOS structured data', () => {
  it('describes the website and repository without rich-result claims', () => {
    expect(agentOsStructuredData).toMatchObject({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          name: 'AgentOS',
          url: 'https://agentos.akua.dev/',
          inLanguage: 'en',
        },
        {
          '@type': 'SoftwareSourceCode',
          name: 'AgentOS',
          codeRepository: 'https://github.com/akua-dev/agentos',
          license: 'https://github.com/akua-dev/agentos/blob/main/LICENSE',
          programmingLanguage: 'TypeScript',
          runtimePlatform: 'Kubernetes',
        },
      ],
    });
    expect(JSON.stringify(agentOsStructuredData)).not.toMatch(
      /aggregateRating|review|offers|downloadCount/,
    );
  });

  it('cannot terminate its own JSON-LD script element', () => {
    expect(serializeStructuredData({ value: '</script><script>' })).toBe(
      '{"value":"\\u003c/script>\\u003cscript>"}',
    );
  });
});
