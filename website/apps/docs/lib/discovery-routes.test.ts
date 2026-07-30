import { describe, expect, it } from 'vitest';
import robots from '@/app/robots';

describe('search and AI-search discovery routes', () => {
  it('explicitly allows current search and user-request crawlers', () => {
    expect(robots()).toEqual({
      rules: [
        {
          userAgent: [
            'OAI-SearchBot',
            'ChatGPT-User',
            'Claude-SearchBot',
            'Claude-User',
            'PerplexityBot',
          ],
          allow: '/',
        },
        { userAgent: '*', allow: '/' },
      ],
      host: 'https://agentos.akua.dev/',
      sitemap: 'https://agentos.akua.dev/sitemap.xml',
    });
  });
});
