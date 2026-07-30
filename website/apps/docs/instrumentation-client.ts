import posthog from 'posthog-js';
import { initializePostHog } from '@/lib/analytics/posthog';

initializePostHog(posthog, {
  projectToken: process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
  host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
});
