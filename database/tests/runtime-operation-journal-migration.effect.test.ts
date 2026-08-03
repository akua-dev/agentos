import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const ids = {
  crewBefore: "26000000-0000-4000-8000-000000000003",
  crewAfter: "26000000-0000-4000-8000-000000000004",
  operation: "76000000-0000-4000-8000-000000000001",
  secondMate: "26000000-0000-4000-8000-000000000002",
};

const databaseLayer = makePGliteTestLayer({
  migrations: { through: 16 },
  setup: (database) => Effect.gen(function*() {
    const root = yield* database.query<{ readonly id: string }>(`
      SELECT id::text AS id
        FROM agentos.agents
       WHERE role = 'first_mate'
    `);
    const firstMateId = (yield* firstRow(root, "test Fleet has no First Mate")).id;

    yield* database.exec(`
      CREATE ROLE journal_upgrade_second LOGIN;
      CREATE ROLE journal_upgrade_crew_before LOGIN;
      CREATE ROLE journal_upgrade_crew_after LOGIN;

      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES
        (
          '${ids.secondMate}', 'journal-upgrade-second', 'second_mate',
          '${firstMateId}', 'pi', 'active', 'Second Mate predates migration'
        ),
        (
          '${ids.crewBefore}', 'journal-upgrade-crew-before', 'crewmate',
          '${ids.secondMate}', 'codex', 'active', 'Crewmate predates migration'
        );

      SELECT agentos.register_agent_principal(
        '${ids.secondMate}', 'journal_upgrade_second'
      );
      SELECT agentos.register_agent_principal(
        '${ids.crewBefore}', 'journal_upgrade_crew_before'
      );
    `);
    yield* database.migrate("0017_runtime_operation_journal.sql");
  }),
});

layer(databaseLayer)("runtime operation journal migration", (it) => {
  it.effect("upgrades existing principals and configures later principals", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const begun = yield* asLogin(
        "journal_upgrade_second",
        database.query<{ readonly id: string }>(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operation}', '${ids.crewBefore}', NULL,
            'agentos-upgrade-domain', 'journal-upgrade-crew-before', 'provision',
            '${"d".repeat(64)}', '[]'::jsonb
          )::text AS id
        `),
      );
      assert.deepStrictEqual(begun, [{ id: ids.operation }]);

      yield* asLogin("journal_upgrade_crew_before", Effect.gen(function*() {
        const visible = yield* database.query<{ readonly phase: string }>(`
          SELECT phase
            FROM agentos.runtime_operations
           WHERE id = '${ids.operation}'
        `);
        assert.deepStrictEqual(visible, [{ phase: "prepared" }]);
        const denied = yield* Effect.flip(database.query(`
          SELECT agentos.begin_runtime_operation(
            gen_random_uuid(), '${ids.crewBefore}', NULL,
            'agentos-upgrade-domain', 'journal-upgrade-crew-before', 'recover',
            '${"e".repeat(64)}', '[]'::jsonb
          )
        `));
        assert.strictEqual(denied.operation, "query");
      }));

      yield* database.exec(`
        INSERT INTO agentos.agents (
          id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
        ) VALUES (
          '${ids.crewAfter}', 'journal-upgrade-crew-after', 'crewmate',
          '${ids.secondMate}', 'codex', 'active', 'Crewmate follows migration'
        );
        SELECT agentos.register_agent_principal(
          '${ids.crewAfter}', 'journal_upgrade_crew_after'
        );
      `);

      yield* asLogin("journal_upgrade_crew_after", Effect.gen(function*() {
        const visible = yield* database.query<{ readonly id: string }>(`
          SELECT id::text
            FROM agentos.runtime_operations
           WHERE id = '${ids.operation}'
        `);
        assert.deepStrictEqual(visible, [{ id: ids.operation }]);
        const denied = yield* Effect.flip(database.exec(`
          UPDATE agentos.runtime_operations
             SET phase = 'failed'
           WHERE id = '${ids.operation}'
        `));
        assert.strictEqual(denied.operation, "exec");
      }));
    }));
});
