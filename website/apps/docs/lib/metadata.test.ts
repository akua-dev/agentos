import { describe, expect, it } from 'vitest';
import {
  createMetadata,
  createNotFoundMetadata,
  defaultDescription,
  defaultTitle,
  socialImage,
} from './metadata';

describe('AgentOS page metadata', () => {
  it('builds a route-specific canonical and complete social card', () => {
    expect(
      createMetadata({
        title: 'Get started',
        description: 'Bring the first AgentOS Fleet online.',
        path: '/docs/start/get-started',
      }),
    ).toMatchObject({
      title: 'Get started',
      description: 'Bring the first AgentOS Fleet online.',
      alternates: {
        canonical: 'https://agentos.akua.dev/docs/start/get-started',
      },
      openGraph: {
        title: 'Get started',
        description: 'Bring the first AgentOS Fleet online.',
        url: 'https://agentos.akua.dev/docs/start/get-started',
        siteName: 'AgentOS',
        type: 'website',
        locale: 'en_US',
        images: [
          {
            url: 'https://agentos.akua.dev/opengraph-image.png',
            width: 1200,
            height: 630,
            alt: 'AgentOS — the open-source company harness',
          },
        ],
      },
      twitter: {
        card: 'summary_large_image',
        creator: '@akua_dev',
        images: ['https://agentos.akua.dev/opengraph-image.png'],
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
    });
  });

  it('exports the approved default copy and image contract', () => {
    expect(defaultTitle).toBe('AgentOS — The open-source company harness');
    expect(defaultDescription).toBe(
      'AgentOS turns persistent AI agents into accountable autonomous companies with durable work, explicit authority, and human control.',
    );
    expect(socialImage).toEqual({
      path: '/opengraph-image.png',
      width: 1200,
      height: 630,
      alt: 'AgentOS — the open-source company harness',
    });
  });

  it('clears inherited SEO fields for not-found responses', () => {
    expect(createNotFoundMetadata('Lesson not found')).toEqual({
      title: 'Lesson not found',
      alternates: null,
      openGraph: null,
      twitter: null,
      robots: null,
    });
  });
});
