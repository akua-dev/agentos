import createBundleAnalyzer from '@next/bundle-analyzer';
import * as BunServices from '@effect/platform-bun/BunServices';
import { createMDX } from 'fumadocs-mdx/next';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
import { Config, Effect, Layer, Option } from 'effect';

import { LiveServerConfig } from './lib/effect/server-config';
import { runServerEffect } from './lib/effect/server-runtime';
import {
  loadBuildEnvironment,
  readGitSourceState,
  resolveBuildProvenance,
} from './scripts/worker-provenance';

const buildNextConfig = Effect.fn('agentos.website.buildNextConfig')(
  function*(phase: string) {
    const appDirectory = yield* Effect.sync(() =>
      fileURLToPath(new URL('.', import.meta.url)),
    );
    const environment = yield* loadBuildEnvironment;
    const analyze = yield* Config.option(Config.string('ANALYZE'));
    const provenance =
      phase === PHASE_PRODUCTION_BUILD
        ? yield* readGitSourceState(appDirectory, environment).pipe(
            Effect.flatMap((gitSource) =>
              resolveBuildProvenance(environment, gitSource),
            ),
          )
        : undefined;
    const headers: Awaited<ReturnType<NonNullable<NextConfig['headers']>>> =
      provenance === undefined
        ? []
        : [
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
    const config: NextConfig = {
      headers: () => runServerEffect(Effect.succeed(headers)),
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

    return yield* Effect.sync(() => {
      const withAnalyzer = createBundleAnalyzer({
        enabled: Option.getOrUndefined(analyze) === 'true',
      });
      return withAnalyzer(createMDX()(config));
    });
  },
);

export default function createNextConfig(phase: string): Promise<NextConfig> {
  return runServerEffect(
    buildNextConfig(phase).pipe(
      Effect.provide(Layer.merge(BunServices.layer, LiveServerConfig)),
    ),
  );
}
