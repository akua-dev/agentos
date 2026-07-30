import createBundleAnalyzer from '@next/bundle-analyzer';
import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

const withAnalyzer = createBundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const workerBuildBranch = process.env.WORKERS_CI_BRANCH?.trim() ?? '';

const config: NextConfig = {
  env: {
    NEXT_PUBLIC_POSTHOG_BUILD_BRANCH: workerBuildBranch,
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
