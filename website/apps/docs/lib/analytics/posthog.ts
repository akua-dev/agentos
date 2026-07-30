import type { PostHogConfig } from 'posthog-js';

export const DEFAULT_POSTHOG_HOST = 'https://ph.akua.dev';

export interface PostHogEnvironment {
  projectToken?: string;
  host?: string;
}

export interface PostHogClient {
  init(token: string, config: Partial<PostHogConfig>): unknown;
}

export function initializePostHog(
  client: PostHogClient,
  environment: PostHogEnvironment,
): boolean {
  const projectToken = environment.projectToken?.trim();

  if (!projectToken) return false;

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
