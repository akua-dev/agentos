import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);
const taskId = "72000000-0000-4000-8000-000000000001";
const firstAssignmentId = "73000000-0000-4000-8000-000000000001";
const secondAssignmentId = "73000000-0000-4000-8000-000000000002";
const firstAgentId = "23000000-0000-4000-8000-000000000001";
const secondAgentId = "23000000-0000-4000-8000-000000000002";
const projectId = "71000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  const files = (await readdir(migrationsDirectory))
    .filter(
      (file) =>
        /^\d+_.+\.sql$/.test(file) && Number.parseInt(file, 10) <= 11,
    )
    .sort();

  for (const file of files) {
    const migration = await import(new URL(file, migrationsDirectory).href, {
      with: { type: "text" },
    });
    await database.exec(migration.default);
  }

  const root = await database.query<{ id: string }>(`
    SELECT id::text AS id
      FROM agentos.agents
     WHERE role = 'first_mate'
  `);

  await database.exec(`
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
        '${root.rows[0]!.id}', 'codex', 'active', 'Agent A ready'
      ),
      (
        '${secondAgentId}', 'preflight-agent-b', 'crewmate',
        '${root.rows[0]!.id}', 'codex', 'active', 'Agent B ready'
      );

    INSERT INTO agentos.tasks (
      id, project_id, created_by_agent_id, title, status, status_text
    ) VALUES (
      '${taskId}', '${projectId}', '${root.rows[0]!.id}',
      'Duplicate active owners', 'active', 'Requires explicit reconciliation'
    );

    INSERT INTO agentos.task_assignments (
      id, task_id, agent_id, assigned_by_agent_id, assignment_role,
      status, status_text, brief, dispatch_profile
    ) VALUES
      (
        '${firstAssignmentId}', '${taskId}', '${firstAgentId}',
        '${root.rows[0]!.id}', 'ship', 'active', 'Agent A owns the work',
        '# Agent A brief',
        '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb
      ),
      (
        '${secondAssignmentId}', '${taskId}', '${secondAgentId}',
        '${root.rows[0]!.id}', 'ship', 'active', 'Agent B also owns the work',
        '# Agent B brief',
        '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb
      );
  `);
});

afterAll(async () => {
  await database.close();
});

test("fails closed on duplicate active owners without discarding work", async () => {
  const migration = await import(
    new URL("0012_atomic_task_acceptance.sql", migrationsDirectory).href,
    { with: { type: "text" } },
  );

  let migrationError: unknown;
  try {
    await database.exec(migration.default);
  } catch (error) {
    migrationError = error;
  }
  const migrationErrorMessage = String(migrationError);
  expect(migrationErrorMessage).toContain(
    "Migration 0012 cannot enforce one active Assignment per Task; reconcile the listed active Assignments by ending or handing off ownership without deleting work, then retry",
  );
  expect(migrationErrorMessage).toContain(taskId);
  expect(migrationErrorMessage).toContain(firstAssignmentId);
  expect(migrationErrorMessage).toContain(secondAssignmentId);
  expect(migrationErrorMessage).toContain(firstAgentId);
  expect(migrationErrorMessage).toContain(secondAgentId);

  const beforeReconciliation = await database.query<{
    active_count: number;
    assignment_ids: string[];
  }>(`
    SELECT
      count(*)::int AS active_count,
      array_agg(id::text ORDER BY id) AS assignment_ids
      FROM agentos.task_assignments
     WHERE task_id = '${taskId}'
       AND ended_at IS NULL
  `);
  expect(beforeReconciliation.rows[0]).toEqual({
    active_count: 2,
    assignment_ids: [firstAssignmentId, secondAssignmentId],
  });

  await database.exec(`
    UPDATE agentos.task_assignments
       SET status = 'completed',
           status_text = 'Reconciled before retry',
           report = 'Agent A ownership was explicitly retained.',
           ended_at = transaction_timestamp()
     WHERE id = '${secondAssignmentId}'
  `);
  await database.exec(migration.default);

  const afterRetry = await database.query<{
    active_count: number;
    index_name: string | null;
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
  expect(afterRetry.rows[0]).toEqual({
    active_count: 1,
    index_name: "agentos.task_assignments_one_active_owner_idx",
  });
});
