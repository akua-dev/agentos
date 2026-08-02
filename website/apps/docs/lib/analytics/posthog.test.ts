import { describe, expect, it, vi } from 'vitest';
import { it as effectIt } from '@effect/vitest';
import { ConfigProvider, Effect } from 'effect';
import {
  DEFAULT_POSTHOG_HOST,
  DEFAULT_POSTHOG_PROJECT_TOKEN,
  initializePostHog,
  loadPostHogConfig,
  resolvePostHogProjectToken,
} from './posthog';

describe('resolvePostHogProjectToken', () => {
  it('uses the public CNAP project token for production builds', () => {
    expect(resolvePostHogProjectToken(undefined, 'production', 'main')).toBe(
      DEFAULT_POSTHOG_PROJECT_TOKEN,
    );
  });

  it('keeps local production builds enabled without Workers metadata', () => {
    expect(resolvePostHogProjectToken(undefined, 'production', undefined)).toBe(
      DEFAULT_POSTHOG_PROJECT_TOKEN,
    );
  });

  it('keeps non-main Workers Builds previews disabled by default', () => {
    expect(
      resolvePostHogProjectToken(undefined, 'production', 'feat/website-posthog'),
    ).toBeUndefined();
  });

  it('keeps development disabled without an explicit token', () => {
    expect(resolvePostHogProjectToken(undefined, 'development', undefined)).toBeUndefined();
  });

  it('prefers a configured project token', () => {
    expect(resolvePostHogProjectToken('  phc_override  ', 'production', 'feature')).toBe(
      'phc_override',
    );
  });
});

describe('initializePostHog', () => {
  effectIt.effect('does not initialize analytics without a project token', () =>
    Effect.gen(function*() {
      const init = vi.fn();
      const initialized = yield* initializePostHog(
        { init },
        {
          projectToken: '   ',
          host: 'https://analytics.example.test',
        },
      );

      expect(initialized).toBe(false);
      expect(init).not.toHaveBeenCalled();
    }));

  effectIt.effect('does not initialize analytics when Do Not Track is enabled', () =>
    Effect.gen(function*() {
      const init = vi.fn();
      const initialized = yield* initializePostHog(
        { init },
        {
          projectToken: 'phc_public_project_token',
          doNotTrack: '1',
        },
      );

      expect(initialized).toBe(false);
      expect(init).not.toHaveBeenCalled();
    }));

  effectIt.effect('treats the browser’s null Do Not Track value as unset', () =>
    Effect.gen(function*() {
      const init = vi.fn();
      const initialized = yield* initializePostHog(
        { init },
        {
          projectToken: 'phc_public_project_token',
          doNotTrack: null,
        },
      );

      expect(initialized).toBe(true);
      expect(init).toHaveBeenCalledOnce();
    }));

  effectIt.effect('initializes cookie-based analytics through the CNAP first-party host', () =>
    Effect.gen(function*() {
      const init = vi.fn();
      const initialized = yield* initializePostHog(
        { init },
        {
          projectToken: '  phc_public_project_token  ',
        },
      );

      expect(initialized).toBe(true);
      expect(init).toHaveBeenCalledOnce();
      expect(init).toHaveBeenCalledWith('phc_public_project_token', {
        api_host: DEFAULT_POSTHOG_HOST,
        capture_pageview: 'history_change',
        defaults: '2026-05-30',
        disable_session_recording: true,
        person_profiles: 'identified_only',
        respect_dnt: true,
      });
    }));

  effectIt.effect('accepts a configured first-party host override', () =>
    Effect.gen(function*() {
      const init = vi.fn();

      yield* initializePostHog(
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
    }));
});

describe('loadPostHogConfig', () => {
  effectIt.effect('decodes public analytics configuration through Effect Config', () =>
    Effect.gen(function*() {
      const config = yield* loadPostHogConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                NODE_ENV: 'production',
                WORKERS_CI_BRANCH: 'main',
                NEXT_PUBLIC_POSTHOG_HOST: 'https://analytics.example.test',
              },
            }),
          ),
        ),
      );

      expect(config).toEqual({
        projectToken: DEFAULT_POSTHOG_PROJECT_TOKEN,
        host: 'https://analytics.example.test/',
      });
    }));
});
