import type { PostHogConfig } from 'posthog-js';
import { Config, Effect, Option, Schema } from 'effect';

export const DEFAULT_POSTHOG_HOST = 'https://ph.akua.dev';
export const DEFAULT_POSTHOG_PROJECT_TOKEN =
  'phc_pctNY25BoznqonkxmCXtbJKg3GpIHl4Ib1efrDOJRup';

export interface PostHogEnvironment {
  projectToken?: string;
  host?: string;
  doNotTrack?: string | number | boolean | null;
  msDoNotTrack?: string | number | boolean | null;
  windowDoNotTrack?: string | number | boolean | null;
}

export interface PostHogPublicConfig {
  readonly projectToken?: string;
  readonly host?: string;
}

export interface PostHogClient {
  init(token: string, config: Partial<PostHogConfig>): unknown;
}

export class PostHogInitializationError extends
  Schema.TaggedErrorClass<PostHogInitializationError>()(
    'PostHogInitializationError',
    {
      message: Schema.String,
      cause: Schema.optional(Schema.Defect()),
    },
  ) {}

const PostHogConfig = Config.all({
  projectToken: Config.option(
    Config.string('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN'),
  ),
  host: Config.option(Config.url('NEXT_PUBLIC_POSTHOG_HOST')),
  nodeEnvironment: Config.option(Config.string('NODE_ENV')),
  buildBranch: Config.option(Config.string('WORKERS_CI_BRANCH')),
});

export const loadPostHogConfig = Effect.gen(function*() {
  const config = yield* PostHogConfig;
  return {
    projectToken: resolvePostHogProjectToken(
      Option.getOrUndefined(config.projectToken),
      Option.getOrUndefined(config.nodeEnvironment),
      Option.getOrUndefined(config.buildBranch),
    ),
    host: Option.getOrUndefined(config.host)?.toString(),
  } satisfies PostHogPublicConfig;
}).pipe(Effect.withSpan('agentos.website.loadPostHogConfig'));

export function resolvePostHogProjectToken(
  configuredToken: string | undefined,
  nodeEnvironment: string | undefined,
  buildBranch: string | undefined,
): string | undefined {
  const token = configuredToken?.trim();
  const branch = buildBranch?.trim();

  if (token) return token;
  if (nodeEnvironment === 'production' && (!branch || branch === 'main')) {
    return DEFAULT_POSTHOG_PROJECT_TOKEN;
  }

  return undefined;
}

function isDoNotTrackEnabled(
  value: string | number | boolean | null | undefined,
): boolean {
  return (
    value === true ||
    value === 1 ||
    value === '1' ||
    value === 'true' ||
    value === 'yes'
  );
}

export const initializePostHog = Effect.fn('agentos.website.initializePostHog')(
  function*(client: PostHogClient, environment: PostHogEnvironment) {
    const projectToken = environment.projectToken?.trim();
    const doNotTrackEnabled = [
      environment.doNotTrack,
      environment.msDoNotTrack,
      environment.windowDoNotTrack,
    ].some(isDoNotTrackEnabled);

    if (!projectToken || doNotTrackEnabled) return false;

    yield* Effect.try({
      try: () =>
        client.init(projectToken, {
          api_host: environment.host?.trim() || DEFAULT_POSTHOG_HOST,
          capture_pageview: 'history_change',
          defaults: '2026-05-30',
          disable_session_recording: true,
          person_profiles: 'identified_only',
          respect_dnt: true,
        }),
      catch: (cause) =>
        new PostHogInitializationError({
          message: 'Could not initialize PostHog analytics',
          cause,
        }),
    });

    return true;
  },
);
