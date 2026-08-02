'use client';

import posthog from 'posthog-js';
import { useEffect } from 'react';
import { Effect } from 'effect';
import {
  initializePostHog,
  type PostHogPublicConfig,
} from '@/lib/analytics/posthog';
import { runBrowserEffect } from '@/lib/effect/browser-runtime';

declare global {
  interface Navigator {
    readonly msDoNotTrack?: string;
  }

  interface Window {
    readonly doNotTrack?: string;
  }
}

export function Analytics({ config }: { config: PostHogPublicConfig }) {
  useEffect(() => {
    return runBrowserEffect(
      Effect.gen(function*() {
        const trackingPreference = yield* Effect.sync(() => ({
          doNotTrack: navigator.doNotTrack,
          msDoNotTrack: navigator.msDoNotTrack,
          windowDoNotTrack: window.doNotTrack,
        }));
        yield* initializePostHog(posthog, {
          ...config,
          ...trackingPreference,
        });
      }).pipe(Effect.catch(() => Effect.void)),
    );
  }, [config.host, config.projectToken]);

  return null;
}
