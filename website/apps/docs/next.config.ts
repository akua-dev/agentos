import createBundleAnalyzer from '@next/bundle-analyzer';
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const withAnalyzer = createBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const workerBuildBranch = process.env.WORKERS_CI_BRANCH?.trim() ?? '';
const workerBuildGitSha = process.env.AGENTOS_BUILD_GIT_SHA?.trim().toLowerCase();

if (workerBuildGitSha && !/^[0-9a-f]{40}$/.test(workerBuildGitSha)) {
  throw new Error(
    'AGENTOS_BUILD_GIT_SHA must be a full 40-character Git SHA.',
  );
}

const config: NextConfig = {
  env: {
    NEXT_PUBLIC_POSTHOG_BUILD_BRANCH: workerBuildBranch,
  },
  async headers() {
    if (!workerBuildGitSha) return [];
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-AgentOS-Git-SHA',
            value: workerBuildGitSha,
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

const withMDX = createMDX();

export default withAnalyzer(withMDX(config));
