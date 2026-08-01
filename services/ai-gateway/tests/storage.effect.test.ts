import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";

import {
  AtomicJsonStoreError,
  makeAtomicJsonStore,
} from "../src/effect-storage.ts";

const CounterSchema = Schema.Struct({
  version: Schema.Literal(1),
  value: Schema.Int,
});

const platform = Layer.mergeAll(
  BunCryptoLayer,
  BunFileSystem.layer,
  BunPath.layer,
);

describe("Effect atomic private JSON storage", () => {
  it.effect("creates private state and preserves concurrent updates", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-store-",
      });
      const path = `${root}/state/counter.json`;
      const store = yield* makeAtomicJsonStore({
        path,
        schema: CounterSchema,
        createDefault: () => ({ version: 1, value: 0 }),
      });
      const peer = yield* makeAtomicJsonStore({
        path,
        schema: CounterSchema,
        createDefault: () => ({ version: 1, value: 0 }),
      });

      const updates = Effect.all(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 === 0 ? store : peer).update((current) => Effect.succeed({
            ...current,
            value: current.value + 1,
          }))),
        { concurrency: "unbounded", discard: true },
      );
      const advanceRetries = Effect.forever(
        TestClock.adjust("10 millis").pipe(
          Effect.andThen(Effect.yieldNow),
        ),
      );
      yield* Effect.raceFirst(updates, advanceRetries);

      assert.strictEqual((yield* store.read).value, 12);
      assert.strictEqual(
        (yield* fileSystem.stat(`${root}/state`)).mode & 0o777,
        0o700,
      );
      assert.strictEqual(
        (yield* fileSystem.stat(path)).mode & 0o777,
        0o600,
      );
      assert.deepStrictEqual(yield* store.inspect, {
        exists: true,
        valid: true,
        mode: 0o600,
      });
    }).pipe(Effect.provide(platform))));

  it.effect("fails closed without leaking malformed persisted contents", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-invalid-store-",
      });
      const path = `${root}/state.json`;
      yield* fileSystem.writeFileString(
        path,
        '{"version":1,"value":"provider-secret"}',
        { mode: 0o600 },
      );
      const store = yield* makeAtomicJsonStore({
        path,
        schema: CounterSchema,
        createDefault: () => ({ version: 1, value: 0 }),
      });

      const failure = yield* Effect.flip(store.read);
      assert.instanceOf(failure, AtomicJsonStoreError);
      assert.strictEqual(failure.code, "invalid_data");
      assert.notInclude(String(failure), "provider-secret");
      assert.notInclude(String(failure), path);
      assert.deepStrictEqual(yield* store.inspect, {
        exists: true,
        valid: false,
        mode: 0o600,
      });
    }).pipe(Effect.provide(platform))));

  it.effect("repairs widened file and directory modes before reading", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-remounted-store-",
      });
      const directory = `${root}/state`;
      const path = `${directory}/counter.json`;
      yield* fileSystem.makeDirectory(directory, { mode: 0o770 });
      yield* fileSystem.writeFileString(
        path,
        '{"version":1,"value":7}',
        { mode: 0o660 },
      );
      yield* fileSystem.chmod(directory, 0o770);
      yield* fileSystem.chmod(path, 0o660);
      const store = yield* makeAtomicJsonStore({
        path,
        schema: CounterSchema,
        createDefault: () => ({ version: 1, value: 0 }),
      });

      assert.deepStrictEqual(yield* store.read, { version: 1, value: 7 });
      assert.strictEqual(
        (yield* fileSystem.stat(directory)).mode & 0o777,
        0o700,
      );
      assert.strictEqual(
        (yield* fileSystem.stat(path)).mode & 0o777,
        0o600,
      );
    }).pipe(Effect.provide(platform))));

  it.effect("holds one interruptible lock across effectful mutations", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-effectful-store-",
      });
      const active = yield* Ref.make(0);
      const maximumActive = yield* Ref.make(0);
      const store = yield* makeAtomicJsonStore({
        path: `${root}/counter.json`,
        schema: CounterSchema,
        createDefault: () => ({ version: 1, value: 0 }),
      });
      const increment = store.update((current) =>
        Effect.gen(function*() {
          const count = yield* Ref.updateAndGet(active, (value) => value + 1);
          yield* Ref.update(maximumActive, (value) => Math.max(value, count));
          yield* Effect.yieldNow;
          yield* Ref.update(active, (value) => value - 1);
          return { ...current, value: current.value + 1 };
        })
      );

      yield* Effect.all([increment, increment], {
        concurrency: "unbounded",
        discard: true,
      });
      assert.strictEqual((yield* store.read).value, 2);
      assert.strictEqual(yield* Ref.get(maximumActive), 1);
    }).pipe(Effect.provide(platform))));

  it.effect("rejects oversized encoded state before replacing the file", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ai-gateway-bounded-store-",
      });
      const store = yield* makeAtomicJsonStore({
        path: `${root}/counter.json`,
        schema: CounterSchema,
        createDefault: () => ({ version: 1, value: 0 }),
        maximumBytes: 24,
      });
      assert.strictEqual((yield* store.read).value, 0);
      const failure = yield* store.update(() =>
        Effect.succeed({ version: 1, value: 1_000_000_000_000 })
      ).pipe(Effect.flip);

      assert.instanceOf(failure, AtomicJsonStoreError);
      assert.strictEqual(failure.code, "invalid_data");
      assert.strictEqual((yield* store.read).value, 0);
    }).pipe(Effect.provide(platform))));
});
