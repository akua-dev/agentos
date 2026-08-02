import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const captainId = "10000000-0000-4000-8000-000000000015";
const secondMateId = "20000000-0000-4000-8000-000000000015";
const taskId = "40000000-0000-4000-8000-000000000015";
const assignmentId = "50000000-0000-4000-8000-000000000015";

const databaseLayer = makePGliteTestLayer({
  migrations: { through: 14 },
  setup: (database) => Effect.gen(function*() {
    const roots = yield* database.query<{ readonly id: string }>(`
      SELECT id::text AS id
        FROM agentos.agents
       WHERE role = 'first_mate'
    `);
    const firstMateId = (yield* firstRow(
      roots,
      "test Fleet has no First Mate",
    )).id;

    yield* database.exec(`
      CREATE ROLE memory_migration_second LOGIN;

      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES (
        '${secondMateId}', 'memory-migration-second', 'second_mate',
        '${firstMateId}', 'pi', 'active', 'Ready for migration verification'
      );

      INSERT INTO agentos.captain (
        id, topic, content, source, recorded_by_agent_id, scope
      ) VALUES (
        '${captainId}', 'communication.primary',
        'Lead with the outcome on the primary Captain surface.',
        'Captain correction', '${firstMateId}', 'fleet'
      );

      INSERT INTO agentos.tasks (
        id, created_by_agent_id, title, status, status_text
      ) VALUES (
        '${taskId}', '${firstMateId}', 'Preserve existing work',
        'active', 'Active before memory migration'
      );

      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, brief, dispatch_profile
      ) VALUES (
        '${assignmentId}', '${taskId}', '${secondMateId}', '${firstMateId}',
        'coordinate', 'active', 'Accepted before memory migration',
        'Continue the existing work after migration.',
        '{"version":1,"harness":"pi","materials":[],"settings":{}}'::jsonb
      );
    `);
  }),
});

layer(databaseLayer)("Captain table removal migration", (it) => {
  it.effect("requires archival, removes the table, and preserves accepted work", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const error = yield* Effect.flip(database.migrate("0015_mate_memory.sql"));
      assert.include(
        error.detail,
        "preserve active Captain rows in the owning Mate's $HOME/memory/",
      );

      const preserved = yield* database.query<{
        readonly content: string;
        readonly relation: string | null;
      }>(`
        SELECT
          to_regclass('agentos.captain')::text AS relation,
          content
          FROM agentos.captain
         WHERE id = '${captainId}'
      `);
      assert.deepStrictEqual(preserved, [{
        content: "Lead with the outcome on the primary Captain surface.",
        relation: "agentos.captain",
      }]);

      yield* database.exec(`
        UPDATE agentos.captain
           SET archived_at = transaction_timestamp()
         WHERE id = '${captainId}'
      `);
      yield* database.migrate("0015_mate_memory.sql");

      const removed = yield* database.query<{ readonly relation: string | null }>(`
        SELECT to_regclass('agentos.captain')::text AS relation
      `);
      assert.isNull((yield* firstRow(removed, "missing relation result")).relation);

      const existingWork = yield* database.query<{
        readonly assignment_status: string;
        readonly task_status: string;
      }>(`
        SELECT
          assignment.status AS assignment_status,
          task.status AS task_status
          FROM agentos.task_assignments AS assignment
          JOIN agentos.tasks AS task ON task.id = assignment.task_id
         WHERE assignment.id = '${assignmentId}'
      `);
      assert.deepStrictEqual(existingWork, [
        { assignment_status: "active", task_status: "active" },
      ]);

      yield* database.exec(`
        SELECT agentos.register_agent_principal(
          '${secondMateId}',
          'memory_migration_second'
        );
        SELECT agentos.configure_agent_runtime_privileges(
          'memory_migration_second',
          'second_mate'
        );
      `);
    }));
});
