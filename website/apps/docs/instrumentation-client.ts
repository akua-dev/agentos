import posthog from 'posthog-js';
import {
  initializePostHog,
  resolvePostHogProjectToken,
} from '@/lib/analytics/posthog';

initializePostHog(posthog, {
  projectToken: resolvePostHogProjectToken(
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
    process.env.NODE_ENV,
  ),
  host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
});
