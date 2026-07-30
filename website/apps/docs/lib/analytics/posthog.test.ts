import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_POSTHOG_HOST, initializePostHog } from './posthog';

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
