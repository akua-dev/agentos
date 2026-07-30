import type { Metadata } from 'next/types';

export const siteName = 'AgentOS';
export const defaultTitle = 'AgentOS — The open-source company harness';
export const defaultDescription =
  'AgentOS turns persistent AI agents into accountable autonomous companies with durable work, explicit authority, and human control.';
export const socialImage = {
  path: '/opengraph-image.png',
  width: 1200,
  height: 630,
  alt: 'AgentOS — the open-source company harness',
} as const;

export const baseUrl = new URL(
  process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.NODE_ENV === 'development'
      ? 'http://localhost:3000'
      : 'https://agentos.akua.dev'),
);

export interface AgentOSPageMetadata {
  title: string;
  description?: string;
  path: `/${string}`;
}

export function absoluteSiteUrl(path: `/${string}`): string {
  return new URL(path, baseUrl).toString();
}

export function createMetadata({
  title,
  description = defaultDescription,
  path,
}: AgentOSPageMetadata): Metadata {
  const canonical = absoluteSiteUrl(path);
  const imageUrl = absoluteSiteUrl(socialImage.path);

  return {
    metadataBase: baseUrl,
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName,
      type: 'website',
      locale: 'en_US',
      images: [
        {
          url: imageUrl,
          width: socialImage.width,
          height: socialImage.height,
          alt: socialImage.alt,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      creator: '@akua_dev',
      title,
      description,
      images: [imageUrl],
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        'max-video-preview': -1,
        'max-image-preview': 'large',
        'max-snippet': -1,
      },
    },
  };
}

export function createNotFoundMetadata(title = 'Not Found'): Metadata {
  return {
    title,
    alternates: null,
    openGraph: null,
    twitter: null,
    robots: {
      index: false,
      follow: false,
      googleBot: {
        index: false,
        follow: false,
      },
    },
  };
}
