import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const withPrerequisites = <A, E, R>(
  operation: Effect.Effect<A, E, R | PGliteTestDatabase>,
) => Effect.scoped(operation.pipe(Effect.provide(
  makePGliteTestLayer({ migrations: { through: 2 } }),
)));

describe("Fleet initialization migration", () => {
  it.effect("initializes the Fleet owner as the root First Mate", () =>
    withPrerequisites(Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* database.migrate("0003_initialize_fleet_owner.sql");

      const firstMates = yield* database.query<{
        readonly database_role: string;
        readonly handle: string;
        readonly harness: string;
        readonly id: string;
        readonly lifecycle_status: string;
        readonly parent_agent_id: string | null;
        readonly role: string;
      }>(`
      SELECT
        id,
        handle,
        role,
        parent_agent_id,
        harness,
        lifecycle_status,
        database_role::text
      FROM agentos.agents
      `);

      const root = yield* firstRow(
        firstMates,
        "Fleet initialization returned no First Mate",
      );
      assert.strictEqual(firstMates.length, 1);
      assert.deepInclude(root, {
        database_role: "postgres",
        handle: "firstmate",
        harness: "pi",
        lifecycle_status: "active",
        parent_agent_id: null,
        role: "first_mate",
      });

      const identity = yield* database.query<{
        readonly id: string;
        readonly role: string;
      }>(`
        SELECT
          agentos.current_agent_id()::text AS id,
          agentos.current_agent_role() AS role
      `);
      assert.deepStrictEqual(identity[0], {
        id: root.id,
        role: "first_mate",
      });
    })));

  it.effect("adopts an existing unbound First Mate without replacing it", () =>
    withPrerequisites(Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
    const existingId = "50000000-0000-4000-8000-000000000001";
      yield* database.exec(`
      INSERT INTO agentos.agents (
        id, handle, display_name, role, harness, lifecycle_status, status_text
      ) VALUES (
        '${existingId}', 'established-first', 'Established First Mate',
        'first_mate', 'pi', 'active', 'Existing runtime awaiting owner binding'
      )
    `);

      yield* database.migrate("0003_initialize_fleet_owner.sql");

      const firstMates = yield* database.query<{
        readonly database_role: string;
        readonly handle: string;
        readonly id: string;
      }>(`
      SELECT id, handle, database_role::text
        FROM agentos.agents
       WHERE role = 'first_mate'
         AND retired_at IS NULL
    `);
      assert.deepStrictEqual(firstMates, [
      {
        database_role: "postgres",
        handle: "established-first",
        id: existingId,
      },
    ]);
    })));

  it.effect("fails closed when active First Mate identity is ambiguous", () =>
    withPrerequisites(Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* database.exec(`
      INSERT INTO agentos.agents (
        handle, role, harness, lifecycle_status, status_text
      ) VALUES
        ('ambiguous-first-a', 'first_mate', 'pi', 'active', 'First candidate'),
        ('ambiguous-first-b', 'first_mate', 'pi', 'active', 'Second candidate')
    `);
      const error = yield* Effect.flip(
        database.migrate("0003_initialize_fleet_owner.sql"),
      );
      assert.include(error.detail, "multiple active First Mates");
    })));

  it.effect("requires migrations to use the Fleet owner login", () =>
    withPrerequisites(Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* database.exec("CREATE ROLE separate_migrator LOGIN");
      const error = yield* Effect.flip(asLogin(
        "separate_migrator",
        database.migrate("0003_initialize_fleet_owner.sql"),
      ));
      assert.include(
        error.detail,
        "must run as Fleet owner postgres",
      );
    })));

  it.effect("rejects an existing First Mate bound to another login", () =>
    withPrerequisites(Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* database.exec(`
      CREATE ROLE wrong_first_mate_login LOGIN;
      INSERT INTO agentos.agents (
        handle, role, harness, lifecycle_status, status_text, database_role
      ) VALUES (
        'wrongly-bound-first', 'first_mate', 'pi', 'active',
        'Existing identity has the wrong database login',
        'wrong_first_mate_login'
      )
    `);
      const error = yield* Effect.flip(
        database.migrate("0003_initialize_fleet_owner.sql"),
      );
      assert.include(
        error.detail,
        "bound to wrong_first_mate_login, expected Fleet owner postgres",
      );
    })));

  it.effect("keeps one active First Mate as the Fleet root", () =>
    withPrerequisites(Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* database.migrate("0003_initialize_fleet_owner.sql");
      const error = yield* Effect.flip(database.exec(`
        INSERT INTO agentos.agents (
          handle, role, harness, lifecycle_status, status_text
        ) VALUES (
          'competing-first', 'first_mate', 'pi', 'active',
          'Attempted competing Fleet root'
        )
      `));
      assert.strictEqual(error.operation, "exec");
    })));
});
