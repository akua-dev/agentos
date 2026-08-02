import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Option, Ref, Stream } from "effect";

import {
  PGliteTestDatabase,
  PGliteTestDatabaseError,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

describe("Effect PGlite test boundary", () => {
  it.effect("acquires, queries, and finalizes the database in a scoped Layer", () =>
    Effect.gen(function*() {
      const finalized = yield* Ref.make(false);
      const program = Effect.gen(function*() {
        const database = yield* PGliteTestDatabase;
        yield* database.exec("CREATE TABLE example (value text NOT NULL)");
        yield* database.exec("INSERT INTO example (value) VALUES ('effect')");
        return yield* database.query<{ readonly value: string }>(
          "SELECT value FROM example",
        );
      });

      const rows = yield* Effect.scoped(program.pipe(Effect.provide(
        makePGliteTestLayer({
          migrations: [],
          releaseProbe: Ref.set(finalized, true),
        }),
      )));

      assert.deepStrictEqual(rows, [{ value: "effect" }]);
      assert.isTrue(yield* Ref.get(finalized));
    }), 15_000);

  it.effect("keeps database failures typed", () =>
    Effect.scoped(Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const exit = yield* Effect.exit(database.query("SELECT * FROM missing"));

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = yield* Effect.flip(database.query("SELECT * FROM missing"));
        assert.instanceOf(error, PGliteTestDatabaseError);
        assert.strictEqual(error.operation, "query");
        assert.notInclude(error.detail, "SELECT * FROM missing");
      }
    }).pipe(Effect.provide(makePGliteTestLayer({ migrations: [] })))));

  it.effect("loads a named migration through the Effect filesystem service", () =>
    Effect.scoped(Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* database.migrate("0000_initial_fleet_schema.sql");
      const schemas = yield* database.query<{ readonly name: string }>(`
        SELECT schema_name AS name
          FROM information_schema.schemata
         WHERE schema_name = 'agentos'
      `);
      assert.deepStrictEqual(schemas, [{ name: "agentos" }]);
    }).pipe(Effect.provide(makePGliteTestLayer({ migrations: [] })))));

  it.effect("restores session authorization after typed failure", () =>
    Effect.scoped(Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* database.exec("CREATE ROLE effect_login_test LOGIN");
      const failure = yield* Effect.flip(asLogin(
        "effect_login_test",
        database.query("SELECT * FROM missing"),
      ));
      assert.strictEqual(failure.operation, "query");

      const users = yield* database.query<{ readonly name: string }>(
        "SELECT current_user AS name",
      );
      assert.strictEqual(
        (yield* firstRow(users, "missing current user")).name,
        "postgres",
      );
    }).pipe(Effect.provide(makePGliteTestLayer({ migrations: [] })))));

  it.effect("turns database notifications into a scoped Effect Stream", () =>
    Effect.scoped(Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const notifications = yield* database.listen("effect_test");
      const notification = yield* Effect.forkChild(
        notifications.pipe(Stream.runHead),
      );

      yield* database.exec("NOTIFY effect_test, 'ready'");
      assert.deepStrictEqual(yield* Fiber.join(notification), Option.some("ready"));
    }).pipe(Effect.provide(makePGliteTestLayer({ migrations: [] })))));
});
