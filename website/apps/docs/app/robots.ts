import type { MetadataRoute } from 'next';
import { baseUrl } from '@/lib/metadata';

export default function robots(): MetadataRoute.Robots {
  return {
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
      {
        userAgent: '*',
        allow: '/',
      },
    ],
    host: baseUrl.toString(),
    sitemap: new URL('/sitemap.xml', baseUrl).toString(),
  };
}
