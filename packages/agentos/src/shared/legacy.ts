import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { ConfigProvider, Effect, Layer } from "effect";

import type { MateMemoryPolicy } from "../memory/policy.ts";
import {
  createMateMemoryStoreEffect,
  type MateMemoryStore,
} from "../memory/store.ts";

const legacyPlatformLayer = Layer.mergeAll(
  BunCrypto.layer,
  BunFileSystem.layer,
  BunPath.layer,
);

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

export function createMateMemoryStoreLegacy(
  home: string,
  overrides: Partial<MateMemoryPolicy> = {},
) {
  const store = runSyncLegacy(
    createMateMemoryStoreEffect(home, overrides).pipe(
      Effect.provide(legacyPlatformLayer),
    ),
  );
  return {
    root: store.root,
    policy: store.policy,
    ensureLayout: (options?: Parameters<MateMemoryStore["ensureLayout"]>[0]) =>
      runPromiseLegacy(store.ensureLayout(options)),
    readStartupContext: (
      options?: Parameters<MateMemoryStore["readStartupContext"]>[0],
    ) => runPromiseLegacy(store.readStartupContext(options)),
    listTopics: (options?: Parameters<MateMemoryStore["listTopics"]>[0]) =>
      runPromiseLegacy(store.listTopics(options)),
    readTopic: (...args: Parameters<MateMemoryStore["readTopic"]>) =>
      runPromiseLegacy(store.readTopic(...args)),
    validateAndStamp: (
      ...args: Parameters<MateMemoryStore["validateAndStamp"]>
    ) => runPromiseLegacy(store.validateAndStamp(...args)),
    writeTopic: (...args: Parameters<MateMemoryStore["writeTopic"]>) =>
      runPromiseLegacy(store.writeTopic(...args)),
    deleteTopic: (...args: Parameters<MateMemoryStore["deleteTopic"]>) =>
      runPromiseLegacy(store.deleteTopic(...args)),
    writeIndex: (...args: Parameters<MateMemoryStore["writeIndex"]>) =>
      runPromiseLegacy(store.writeIndex(...args)),
    resolveMemoryPath: (
      ...args: Parameters<MateMemoryStore["resolveMemoryPath"]>
    ) => runPromiseLegacy(store.resolveMemoryPath(...args)),
  };
}
