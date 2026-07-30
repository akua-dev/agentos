import createBundleAnalyzer from '@next/bundle-analyzer';
import { createMDX } from 'fumadocs-mdx/next';
import { fileURLToPath } from 'node:url';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import type { NextConfig } from 'next';
import {
  readGitSourceState,
  resolveBuildProvenance,
} from './scripts/worker-provenance';

const withAnalyzer = createBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const appDirectory = fileURLToPath(new URL('.', import.meta.url));
const withMDX = createMDX();

export default function createNextConfig(phase: string): NextConfig {
  const provenance =
    phase === PHASE_PRODUCTION_BUILD
      ? resolveBuildProvenance(
          process.env,
          readGitSourceState(appDirectory),
        )
      : undefined;
  const workerBuildBranch =
    provenance?.gitBranch ??
    process.env.WORKERS_CI_BRANCH?.trim() ??
    '';

  const config: NextConfig = {
    env: {
      NEXT_PUBLIC_POSTHOG_BUILD_BRANCH: workerBuildBranch,
    },
    async headers() {
      if (!provenance) return [];
      return [
        {
          source: '/:path*',
          headers: [
            {
              key: 'X-AgentOS-Git-SHA',
              value: provenance.gitSha,
            },
          ],
        },
      ];
    },
    reactStrictMode: true,
    experimental: {
      globalNotFound: true,
    },
    logging: {
      fetches: {
        fullUrl: true,
      },
    },
    images: {
      remotePatterns: [
        {
          protocol: 'https',
          hostname: 'avatars.githubusercontent.com',
          port: '',
        },
      ],
    },
  };

  return withAnalyzer(withMDX(config));
}
