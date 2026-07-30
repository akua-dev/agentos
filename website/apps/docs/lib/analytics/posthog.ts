import type { PostHogConfig } from 'posthog-js';

export const DEFAULT_POSTHOG_HOST = 'https://ph.akua.dev';
export const DEFAULT_POSTHOG_PROJECT_TOKEN =
  'phc_pctNY25BoznqonkxmCXtbJKg3GpIHl4Ib1efrDOJRup';

export interface PostHogEnvironment {
  projectToken?: string;
  host?: string;
  doNotTrack?: string | number | boolean;
  msDoNotTrack?: string | number | boolean;
  windowDoNotTrack?: string | number | boolean;
}

export interface PostHogClient {
  init(token: string, config: Partial<PostHogConfig>): unknown;
}

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

function isDoNotTrackEnabled(value: string | number | boolean | undefined): boolean {
  return (
    value === true ||
    value === 1 ||
    value === '1' ||
    value === 'true' ||
    value === 'yes'
  );
}

export function initializePostHog(
  client: PostHogClient,
  environment: PostHogEnvironment,
): boolean {
  const projectToken = environment.projectToken?.trim();
  const doNotTrackEnabled = [
    environment.doNotTrack,
    environment.msDoNotTrack,
    environment.windowDoNotTrack,
  ].some(isDoNotTrackEnabled);

  if (!projectToken || doNotTrackEnabled) return false;

  client.init(projectToken, {
    api_host: environment.host?.trim() || DEFAULT_POSTHOG_HOST,
    capture_pageview: 'history_change',
    cookieless_mode: 'always',
    defaults: '2026-05-30',
    disable_session_recording: true,
    person_profiles: 'identified_only',
    respect_dnt: true,
  });

  return true;
}
