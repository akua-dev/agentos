import type { MetadataRoute } from 'next';
import { runServerEffect } from '@/lib/effect/server-runtime';
import { buildSitemap } from '@/lib/sitemap';
import { learnSource, source } from '@/lib/source';

export const revalidate = false;

export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return runServerEffect(
    buildSitemap([...source.getPages(), ...learnSource.getPages()]),
  );
}
