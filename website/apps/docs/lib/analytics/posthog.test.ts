import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_POSTHOG_HOST,
  DEFAULT_POSTHOG_PROJECT_TOKEN,
  initializePostHog,
  resolvePostHogProjectToken,
} from './posthog';

describe('resolvePostHogProjectToken', () => {
  it('uses the public CNAP project token for production builds', () => {
    expect(resolvePostHogProjectToken(undefined, 'production')).toBe(
      DEFAULT_POSTHOG_PROJECT_TOKEN,
    );
  });

  it('keeps development disabled without an explicit token', () => {
    expect(resolvePostHogProjectToken(undefined, 'development')).toBeUndefined();
  });

  it('prefers a configured project token', () => {
    expect(resolvePostHogProjectToken('  phc_override  ', 'production')).toBe(
      'phc_override',
    );
  });
});

describe('initializePostHog', () => {
  it('does not initialize analytics without a project token', () => {
    const init = vi.fn();

    expect(
      initializePostHog(
        { init },
        {
          projectToken: '   ',
          host: 'https://analytics.example.test',
        },
      ),
    ).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('initializes cookieless analytics through the CNAP first-party host', () => {
    const init = vi.fn();

    expect(
      initializePostHog(
        { init },
        {
          projectToken: '  phc_public_project_token  ',
        },
      ),
    ).toBe(true);
    expect(init).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledWith('phc_public_project_token', {
      api_host: DEFAULT_POSTHOG_HOST,
      capture_pageview: 'history_change',
      cookieless_mode: 'always',
      defaults: '2026-05-30',
      disable_session_recording: true,
      person_profiles: 'identified_only',
      respect_dnt: true,
    });
  });

  it('accepts a configured first-party host override', () => {
    const init = vi.fn();

    initializePostHog(
      { init },
      {
        projectToken: 'phc_public_project_token',
        host: '  https://analytics.example.test/  ',
      },
    );

    expect(init).toHaveBeenCalledWith(
      'phc_public_project_token',
      expect.objectContaining({
        api_host: 'https://analytics.example.test/',
      }),
    );
  });
});
