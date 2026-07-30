import type { Metadata } from 'next/types';

export const baseUrl = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.NODE_ENV === 'development'
      ? 'http://localhost:3000'
      : 'https://agentos.akua.dev'),
);

export function createMetadata(override: Metadata): Metadata {
  return {
    ...override,
    openGraph: {
      title: override.title ?? undefined,
      description: override.description ?? undefined,
      url: baseUrl.toString(),
      images: '/banner.png',
      siteName: 'AgentOS',
      ...override.openGraph,
    },
    twitter: {
      card: 'summary_large_image',
      creator: '@akua_dev',
      title: override.title ?? undefined,
      description: override.description ?? undefined,
      images: '/banner.png',
      ...override.twitter,
    },
    alternates: override.alternates,
  };
}
