import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  Runtime,
  Sink,
  Stdio,
  Stream,
} from "effect";

import {
  loadPostgresClientConfig,
  PgListenError,
  PostgresNotificationSource,
  runPgListen,
  waitForNotification,
} from "../pg-listen.ts";
import type { PostgresListenerEvent } from "../pg-listen.ts";

const ready = (channel: string): PostgresListenerEvent => ({
  state: "listening",
  channel,
});

const notification = (
  channel: string,
  payload: string,
): PostgresListenerEvent => ({
  state: "notification",
  channel,
  payload,
});

const capturedStdio = Effect.fn("test.pgListen.stdio")(
  function*(args: ReadonlyArray<string>) {
    const stderr = yield* Ref.make("");
    const stdout = yield* Ref.make("");
    const capture = (output: Ref.Ref<string>) =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Ref.update(output, (current) =>
          current + (typeof chunk === "string"
            ? chunk
            : new TextDecoder().decode(chunk))
        ));
    const layer = Stdio.layerTest({
      args: Effect.succeed(args),
      stderr: () => capture(stderr),
      stdout: () => capture(stdout),
    });
    return { layer, stderr, stdout };
  },
);

const sourceLayer = (
  events: Stream.Stream<
    | { readonly state: "listening"; readonly channel: string }
    | {
      readonly state: "notification";
      readonly channel: string;
      readonly payload: string;
    },
    PgListenError
  >,
) => Layer.succeed(
  PostgresNotificationSource,
  PostgresNotificationSource.of({ events: () => events }),
);

const emptySource = sourceLayer(Stream.empty);

function environment(values: Readonly<Record<string, string>>) {
  return ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...values } }));
}

describe("pg-listen", () => {
  it.effect("exposes help without PostgreSQL configuration", () =>
    Effect.gen(function*() {
      const stdio = yield* capturedStdio(["--help"]);
      yield* runPgListen.pipe(
        Effect.provide(stdio.layer),
        Effect.provide(emptySource),
      );

      const output = yield* Ref.get(stdio.stdout);
      assert.include(output, "pg-listen <channel>");
      assert.notInclude(output, "AgentOS");
    }));

  it.effect("requires exactly one channel before opening a source", () =>
    Effect.gen(function*() {
      const stdio = yield* capturedStdio([]);
      const failure = yield* runPgListen.pipe(
        Effect.provide(stdio.layer),
        Effect.provide(emptySource),
        Effect.flip,
      );

      assert.strictEqual(failure[Runtime.errorExitCode], 2);
      assert.include(failure.message, "Usage: pg-listen <channel>");
      assert.strictEqual(yield* Ref.get(stdio.stdout), "");
    }));

  it.effect("announces readiness before preserving the first payload", () =>
    Effect.gen(function*() {
      const stdio = yield* capturedStdio([]);
      const events = Stream.make(
        ready("fleet.events"),
        notification(
          "fleet.events",
          '{"version":1,"table":"inbox","operation":"insert"}',
        ),
      );

      const result = yield* waitForNotification("fleet.events").pipe(
        Effect.provide(stdio.layer),
        Effect.provide(sourceLayer(events)),
      );

      assert.deepStrictEqual(result, {
        channel: "fleet.events",
        payload: '{"version":1,"table":"inbox","operation":"insert"}',
      });
      assert.strictEqual(
        yield* Ref.get(stdio.stderr),
        '{"state":"listening","channel":"fleet.events"}\n',
      );
      assert.strictEqual(
        yield* Ref.get(stdio.stdout),
        '{"channel":"fleet.events","payload":"{\\"version\\":1,\\"table\\":\\"inbox\\",\\"operation\\":\\"insert\\"}"}\n',
      );
    }));

  it.effect("scopes and finalizes the source after one notification", () =>
    Effect.gen(function*() {
      const finalized = yield* Ref.make(false);
      const stdio = yield* capturedStdio([]);
      const events = Stream.make(
        ready("agentos_events"),
        notification("agentos_events", "{}"),
      ).pipe(Stream.ensuring(Ref.set(finalized, true)));

      yield* waitForNotification("agentos_events").pipe(
        Effect.provide(stdio.layer),
        Effect.provide(sourceLayer(events)),
      );

      assert.isTrue(yield* Ref.get(finalized));
    }));

  it.effect("resolves a matching private pgpass entry before client creation", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "pg-listen-pgpass-",
      });
      const passwordFile = paths.join(directory, "pgpass");
      yield* fileSystem.writeFileString(
        passwordFile,
        "db.internal:5432:fleet:runtime_agent:test-password\n",
        { mode: 0o600 },
      );

      const config = yield* loadPostgresClientConfig.pipe(
        Effect.provide(environment({
          DATABASE_URL:
            "postgresql://runtime_agent@db.internal:5432/fleet?sslmode=verify-full",
          PGPASSFILE: passwordFile,
        })),
      );

      assert.strictEqual(config.password, "test-password");
      assert.strictEqual(config.application_name, "pg-listen");
    }).pipe(Effect.provide(BunServices.layer))));

  it.effect("rejects an ended source before a notification", () =>
    Effect.gen(function*() {
      const stdio = yield* capturedStdio([]);
      const failure = yield* waitForNotification("agentos_events").pipe(
        Effect.provide(stdio.layer),
        Effect.provide(sourceLayer(Stream.make(ready("agentos_events")))),
        Effect.flip,
      );

      assert.strictEqual(failure.code, "connection_ended");
    }));
});
