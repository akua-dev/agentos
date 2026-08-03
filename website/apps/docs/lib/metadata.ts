import type { Metadata } from 'next/types';
import { Config, Effect, Option, Schema } from 'effect';
import { runServerSync } from './effect/server-runtime';
import { LiveServerConfig } from './effect/server-config';

export const siteName = 'AgentOS';
export const defaultTitle = 'AgentOS — The open-source company harness';
export const defaultDescription =
  'AgentOS turns persistent AI agents into accountable autonomous companies with durable work, explicit authority, and human control.';
export const socialImage: {
  readonly path: '/opengraph-image.png';
  readonly width: 1200;
  readonly height: 630;
  readonly alt: string;
} = {
  path: '/opengraph-image.png',
  width: 1200,
  height: 630,
  alt: 'AgentOS — the open-source company harness',
};

export class SiteMetadataConfigError extends
  Schema.TaggedErrorClass<SiteMetadataConfigError>()('SiteMetadataConfigError', {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {}

const SiteEnvironment = Config.all({
  nodeEnvironment: Config.option(Config.string('NODE_ENV')),
  siteUrl: Config.option(Config.string('NEXT_PUBLIC_SITE_URL')),
});

export const loadSiteMetadataConfig = Effect.gen(function*() {
  const environment = yield* SiteEnvironment;
  const configured = Option.getOrUndefined(environment.siteUrl);
  const raw = configured ??
    (Option.getOrUndefined(environment.nodeEnvironment) === 'development'
      ? 'http://localhost:3000'
      : 'https://agentos.akua.dev');
  const baseUrl = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(raw).pipe(
    Effect.mapError((cause) =>
      new SiteMetadataConfigError({
        message: 'NEXT_PUBLIC_SITE_URL must be an absolute URL',
        cause,
      })
    ),
  );
  return { baseUrl };
}).pipe(Effect.withSpan('agentos.website.loadSiteMetadataConfig'));

const liveMetadata = runServerSync(
  loadSiteMetadataConfig.pipe(
    Effect.provide(LiveServerConfig),
    Effect.orDie,
  ),
);

export const baseUrl = liveMetadata.baseUrl;

export interface AgentOSPageMetadata {
  title: string;
  description?: string;
  path: string;
}

export function absoluteSiteUrl(path: string): string {
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
    robots: null,
  };
}
