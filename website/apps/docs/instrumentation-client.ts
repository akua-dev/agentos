import posthog from 'posthog-js';
import {
  initializePostHog,
  resolvePostHogProjectToken,
} from '@/lib/analytics/posthog';

initializePostHog(posthog, {
  projectToken: resolvePostHogProjectToken(
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
    process.env.NODE_ENV,
    process.env.NEXT_PUBLIC_POSTHOG_BUILD_BRANCH,
  ),
  host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  doNotTrack: typeof navigator === 'undefined' ? undefined : navigator.doNotTrack,
  msDoNotTrack:
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { msDoNotTrack?: string }).msDoNotTrack,
  windowDoNotTrack:
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { doNotTrack?: string }).doNotTrack,
});
