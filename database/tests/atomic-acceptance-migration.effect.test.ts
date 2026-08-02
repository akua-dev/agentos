import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const taskId = "72000000-0000-4000-8000-000000000001";
const firstAssignmentId = "73000000-0000-4000-8000-000000000001";
const secondAssignmentId = "73000000-0000-4000-8000-000000000002";
const firstAgentId = "23000000-0000-4000-8000-000000000001";
const secondAgentId = "23000000-0000-4000-8000-000000000002";
const projectId = "71000000-0000-4000-8000-000000000001";

const databaseLayer = makePGliteTestLayer({
  migrations: { through: 11 },
  setup: (database) => Effect.gen(function*() {
    const root = yield* database.query<{ readonly id: string }>(`
      SELECT id::text AS id
        FROM agentos.agents
       WHERE role = 'first_mate'
    `);
    const firstMateId = (yield* firstRow(root, "test Fleet has no First Mate")).id;

    yield* database.exec(`
      INSERT INTO agentos.projects (
        id, name, scope_text, status, status_text
      ) VALUES (
        '${projectId}', 'migration-preflight',
        'Exercise duplicate Assignment migration safety', 'active', 'Ready'
      );

      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES
        (
          '${firstAgentId}', 'preflight-agent-a', 'crewmate',
          '${firstMateId}', 'codex', 'active', 'Agent A ready'
        ),
        (
          '${secondAgentId}', 'preflight-agent-b', 'crewmate',
          '${firstMateId}', 'codex', 'active', 'Agent B ready'
        );

      INSERT INTO agentos.tasks (
        id, project_id, created_by_agent_id, title, status, status_text
      ) VALUES (
        '${taskId}', '${projectId}', '${firstMateId}',
        'Duplicate active owners', 'active', 'Requires explicit reconciliation'
      );

      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, brief, dispatch_profile
      ) VALUES
        (
          '${firstAssignmentId}', '${taskId}', '${firstAgentId}',
          '${firstMateId}', 'ship', 'active', 'Agent A owns the work',
          '# Agent A brief',
          '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb
        ),
        (
          '${secondAssignmentId}', '${taskId}', '${secondAgentId}',
          '${firstMateId}', 'ship', 'active', 'Agent B also owns the work',
          '# Agent B brief',
          '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb
        );
    `);
  }),
});

layer(databaseLayer)("atomic acceptance migration", (it) => {
  it.effect("fails closed on duplicate active owners without discarding work", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const migrationError = yield* Effect.flip(
        database.migrate("0012_atomic_task_acceptance.sql"),
      );
      assert.include(
        migrationError.detail,
        "Migration 0012 cannot enforce one active Assignment per Task; reconcile the listed active Assignments by ending or handing off ownership without deleting work, then retry",
      );
      for (const id of [
        taskId,
        firstAssignmentId,
        secondAssignmentId,
        firstAgentId,
        secondAgentId,
      ]) assert.include(migrationError.detail, id);

      const beforeReconciliation = yield* database.query<{
        readonly active_count: number;
        readonly assignment_ids: ReadonlyArray<string>;
      }>(`
        SELECT
          count(*)::int AS active_count,
          array_agg(id::text ORDER BY id) AS assignment_ids
          FROM agentos.task_assignments
         WHERE task_id = '${taskId}'
           AND ended_at IS NULL
      `);
      assert.deepStrictEqual(beforeReconciliation[0], {
        active_count: 2,
        assignment_ids: [firstAssignmentId, secondAssignmentId],
      });

      yield* database.exec(`
        UPDATE agentos.task_assignments
           SET status = 'completed',
               status_text = 'Reconciled before retry',
               report = 'Agent A ownership was explicitly retained.',
               ended_at = transaction_timestamp()
         WHERE id = '${secondAssignmentId}'
      `);
      yield* database.migrate("0012_atomic_task_acceptance.sql");

      const afterRetry = yield* database.query<{
        readonly active_count: number;
        readonly index_name: string | null;
      }>(`
        SELECT
          (
            SELECT count(*)::int
              FROM agentos.task_assignments
             WHERE task_id = '${taskId}'
               AND ended_at IS NULL
          ) AS active_count,
          to_regclass('agentos.task_assignments_one_active_owner_idx')::text
            AS index_name
      `);
      assert.deepStrictEqual(afterRetry[0], {
        active_count: 1,
        index_name: "agentos.task_assignments_one_active_owner_idx",
      });
    }));
});
