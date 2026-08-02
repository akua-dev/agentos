import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const ids = {
  crewBefore: "27000000-0000-4000-8000-000000000003",
  crewAfter: "27000000-0000-4000-8000-000000000004",
  legacyOperation: "77000000-0000-4000-8000-000000000001",
  typedOperation: "77000000-0000-4000-8000-000000000002",
  secondMate: "27000000-0000-4000-8000-000000000002",
};
const specDigest = "a".repeat(64);
const overlayDigest = "b".repeat(64);
const renderDigest = "c".repeat(64);

const databaseLayer = makePGliteTestLayer({
  migrations: { through: 23 },
  setup: (database) => Effect.gen(function*() {
    const roots = yield* database.query<{ readonly id: string }>(`
      SELECT id::text AS id FROM agentos.agents WHERE role = 'first_mate'
    `);
    const firstMateId = (yield* firstRow(
      roots,
      "test Fleet has no First Mate",
    )).id;
    yield* database.exec(`
      CREATE ROLE workload_upgrade_second LOGIN;
      CREATE ROLE workload_upgrade_crew_before LOGIN;
      CREATE ROLE workload_upgrade_crew_after LOGIN;

      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES
        (
          '${ids.secondMate}', 'workload-upgrade-second', 'second_mate',
          '${firstMateId}', 'pi', 'active', 'Second Mate predates provenance'
        ),
        (
          '${ids.crewBefore}', 'workload-upgrade-crew-before', 'crewmate',
          '${ids.secondMate}', 'codex', 'active', 'Crewmate predates provenance'
        ),
        (
          '${ids.crewAfter}', 'workload-upgrade-crew-after', 'crewmate',
          '${ids.secondMate}', 'codex', 'active', 'Crewmate adopts provenance'
        );

      SELECT agentos.register_agent_principal(
        '${ids.secondMate}', 'workload_upgrade_second'
      );
      SELECT agentos.register_agent_principal(
        '${ids.crewBefore}', 'workload_upgrade_crew_before'
      );
      SELECT agentos.register_agent_principal(
        '${ids.crewAfter}', 'workload_upgrade_crew_after'
      );
    `);
  }),
});

layer(databaseLayer)("workload operation provenance migration", (it) => {
  it.effect("preserves generic operations and grants only Mates the typed boundary", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin("workload_upgrade_second", database.query(`
        SELECT agentos.begin_runtime_operation(
          '${ids.legacyOperation}', '${ids.crewBefore}', NULL,
          'agentos-upgrade-domain', 'workload-upgrade-crew-before',
          'provision', '${renderDigest}', '[]'::jsonb
        )
      `));

      yield* database.migrate(
        "0024_runtime_operation_workload_provenance.sql",
      );

      const legacy = yield* database.query<{
        readonly workload_overlay_digest: string | null;
        readonly workload_spec_digest: string | null;
        readonly workload_spec_version: number | null;
      }>(`
        SELECT workload_spec_version, workload_spec_digest,
               workload_overlay_digest
          FROM agentos.runtime_operations
         WHERE id = '${ids.legacyOperation}'
      `);
      assert.deepStrictEqual(legacy, [{
        workload_overlay_digest: null,
        workload_spec_digest: null,
        workload_spec_version: null,
      }]);

      const typed = yield* asLogin(
        "workload_upgrade_second",
        database.query<{ readonly id: string }>(`
          SELECT agentos.begin_workload_runtime_operation(
            '${ids.typedOperation}', '${ids.crewAfter}', NULL,
            'agentos-upgrade-domain', 'workload-upgrade-crew-after',
            'provision', 1, '${specDigest}', '${overlayDigest}',
            '${renderDigest}', '[]'::jsonb
          )::text AS id
        `),
      );
      assert.deepStrictEqual(typed, [{ id: ids.typedOperation }]);

      const crewDenied = yield* Effect.flip(asLogin(
        "workload_upgrade_crew_after",
        database.query(`
          SELECT agentos.begin_workload_runtime_operation(
            gen_random_uuid(), '${ids.crewAfter}', NULL,
            'agentos-upgrade-domain', 'workload-upgrade-crew-after',
            'recover', 1, '${specDigest}', '${overlayDigest}',
            '${renderDigest}', '[]'::jsonb
          )
        `),
      ));
      assert.strictEqual(crewDenied.operation, "query");

      const directMutation = yield* Effect.flip(asLogin(
        "workload_upgrade_second",
        database.exec(`
          UPDATE agentos.runtime_operations
             SET workload_spec_digest = '${"d".repeat(64)}'
           WHERE id = '${ids.typedOperation}'
        `),
      ));
      assert.strictEqual(directMutation.operation, "exec");
    }));
});
