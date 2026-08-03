import {
  absoluteSiteUrl,
  defaultDescription,
  siteName,
} from './metadata';

export const agentOsStructuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': absoluteSiteUrl('/#website'),
      name: siteName,
      url: absoluteSiteUrl('/'),
      description: defaultDescription,
      inLanguage: 'en',
    },
    {
      '@type': 'SoftwareSourceCode',
      '@id': 'https://github.com/akua-dev/agentos#software',
      name: siteName,
      description: defaultDescription,
      url: absoluteSiteUrl('/'),
      codeRepository: 'https://github.com/akua-dev/agentos',
      license: 'https://github.com/akua-dev/agentos/blob/main/LICENSE',
      programmingLanguage: 'TypeScript',
      runtimePlatform: 'Kubernetes',
      author: {
        '@type': 'Organization',
        name: 'Akua',
        url: 'https://github.com/akua-dev',
      },
    },
  ],
};

export function serializeStructuredData(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
