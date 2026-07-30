import type { MetadataRoute } from 'next';
import { baseUrl } from '@/lib/metadata';
import { learnSource, source } from '@/lib/source';

export const revalidate = false;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const absolute = (path: string): string => new URL(path, baseUrl).toString();
  const content = await Promise.all(
    [...source.getPages(), ...learnSource.getPages()].map(async (page) => {
      const { lastModified } = await page.data.load();
      return {
        url: absolute(page.url),
        lastModified: lastModified ? new Date(lastModified) : undefined,
        changeFrequency: 'weekly' as const,
        priority: page.url === '/docs' ? 0.8 : 0.6,
      };
    }),
  );

  return [
    { url: absolute('/'), changeFrequency: 'monthly', priority: 1 },
    { url: absolute('/learn'), changeFrequency: 'monthly', priority: 0.9 },
    { url: absolute('/benchmarks'), changeFrequency: 'weekly', priority: 0.7 },
    ...content,
  ];
}
