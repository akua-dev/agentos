import { ConfigProvider, Effect } from "effect";

export function legacyEnvironmentConfigLayer() {
  return ConfigProvider.layer(ConfigProvider.fromEnv());
}

export function runSyncLegacy<A, E>(effect: Effect.Effect<A, E>): A {
  return Effect.runSync(effect);
}

export function runPromiseLegacy<A, E>(
  effect: Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(effect);
}
