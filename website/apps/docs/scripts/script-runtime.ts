import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import * as BunHttpClient from '@effect/platform-bun/BunHttpClient';
import { Effect, Layer } from 'effect';
import { HttpClient } from 'effect/unstable/http';

type WebsiteScriptServices =
  | BunServices.BunServices
  | HttpClient.HttpClient;

const WebsiteScriptPlatform = Layer.merge(
  BunServices.layer,
  BunHttpClient.layer,
);

/** One-way Bun adapter shared by every executable website script. */
export function runWebsiteScript<A, E>(
  program: Effect.Effect<A, E, WebsiteScriptServices>,
): void {
  BunRuntime.runMain(program.pipe(Effect.provide(WebsiteScriptPlatform)));
}
