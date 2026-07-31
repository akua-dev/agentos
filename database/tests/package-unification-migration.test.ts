import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);
const agentId = "24000000-0000-4000-8000-000000000001";
const assignmentId = "54000000-0000-4000-8000-000000000001";
const projectId = "34000000-0000-4000-8000-000000000001";
const taskId = "44000000-0000-4000-8000-000000000001";
let firstMateId = "";

beforeAll(async () => {
  const files = (await readdir(migrationsDirectory))
    .filter(
      (file) =>
        /^\d+_.+\.sql$/.test(file) && Number.parseInt(file, 10) <= 15,
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
  firstMateId = root.rows[0]!.id;

  await database.exec(`
    INSERT INTO agentos.projects (
      id, name, scope_text, status, status_text
    ) VALUES (
      '${projectId}', 'package-unification-migration',
      'Verify the published schema upgrades append-only',
      'active', 'Migration fixture ready'
    );

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES (
      '${agentId}', 'migration-worker', 'crewmate', '${firstMateId}',
      'codex', 'active', 'Worker ready'
    );
  `);

  await database.query(`
    SELECT accepted_task_id, accepted_assignment_id
      FROM agentos.create_task_with_assignment(
        '${taskId}',
        '${assignmentId}',
        '${agentId}',
        '${projectId}',
        NULL,
        'Preserve accepted work',
        'Keep the exact accepted Task through package unification.',
        'active',
        'Accepted before package unification',
        'high',
        '[]'::jsonb,
        '[]'::jsonb,
        '{"source":"migration-test"}'::jsonb,
        'ship',
        'assigned',
        'Worker owns the accepted outcome',
        '# Complete migration brief',
        '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb,
        '{"acceptance":"initial"}'::jsonb
      )
  `);

  const migration = await import(
    new URL("0016_unify_agentos_package.sql", migrationsDirectory).href,
    { with: { type: "text" } },
  );
  await database.exec(migration.default);
});

afterAll(async () => {
  await database.close();
});

test("upgrades the published schema without losing accepted work", async () => {
  const schema = await database.query<{
    assignment_dispatch: string | null;
    composition_validator: string | null;
    resolved_composition: string | null;
  }>(`
    SELECT
      (
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'agentos'
           AND table_name = 'task_assignments'
           AND column_name = 'dispatch_profile'
      ) AS assignment_dispatch,
      to_regprocedure('agentos.valid_composition_manifest(jsonb)')::text
        AS composition_validator,
      (
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'agentos'
           AND table_name = 'agents'
           AND column_name = 'resolved_composition'
      ) AS resolved_composition
  `);
  expect(schema.rows).toEqual([
    {
      assignment_dispatch: null,
      composition_validator: null,
      resolved_composition: null,
    },
  ]);

  const obsoleteObjects = await database.query<{
    object_kind: string;
    object_name: string;
  }>(`
    SELECT 'function'::text AS object_kind, procedure.proname AS object_name
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'agentos'
       AND (
         procedure.proname LIKE '%composition%'
         OR procedure.proname LIKE '%dispatch%'
       )
    UNION ALL
    SELECT 'trigger'::text, trigger.tgname
      FROM pg_trigger AS trigger
      JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'agentos'
       AND NOT trigger.tgisinternal
       AND (
         trigger.tgname LIKE '%composition%'
         OR trigger.tgname LIKE '%dispatch%'
       )
    ORDER BY object_kind, object_name
  `);
  expect(obsoleteObjects.rows).toEqual([]);

  const acceptanceSignatures = await database.query<{
    arguments: string;
    name: string;
  }>(`
    SELECT
      procedure.proname AS name,
      pg_get_function_identity_arguments(procedure.oid) AS arguments
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'agentos'
       AND procedure.proname IN (
         'accept_backlog_task',
         'create_task_with_assignment',
         'handoff_task_assignment'
       )
     ORDER BY procedure.proname
  `);
  expect(acceptanceSignatures.rows).toEqual([
    {
      arguments:
        "p_task_id uuid, p_assignment_id uuid, p_agent_id uuid, p_task_status text, p_task_status_text text, p_assignment_role text, p_assignment_status text, p_assignment_status_text text, p_brief text, p_assignment_metadata jsonb",
      name: "accept_backlog_task",
    },
    {
      arguments:
        "p_task_id uuid, p_assignment_id uuid, p_agent_id uuid, p_project_id uuid, p_parent_task_id uuid, p_title text, p_description text, p_task_status text, p_task_status_text text, p_priority text, p_dependencies jsonb, p_external_links jsonb, p_task_metadata jsonb, p_assignment_role text, p_assignment_status text, p_assignment_status_text text, p_brief text, p_assignment_metadata jsonb",
      name: "create_task_with_assignment",
    },
    {
      arguments:
        "p_assignment_id uuid, p_destination_agent_id uuid, p_brief text, p_report text, p_status_text text",
      name: "handoff_task_assignment",
    },
  ]);

  const accepted = await database.query<{
    accepted_assignment_id: string;
    accepted_task_id: string;
  }>(`
    SELECT accepted_task_id::text, accepted_assignment_id::text
      FROM agentos.create_task_with_assignment(
        '${taskId}',
        '${assignmentId}',
        '${agentId}',
        '${projectId}',
        NULL,
        'Preserve accepted work',
        'Keep the exact accepted Task through package unification.',
        'active',
        'Accepted before package unification',
        'high',
        '[]'::jsonb,
        '[]'::jsonb,
        '{"source":"migration-test"}'::jsonb,
        'ship',
        'assigned',
        'Worker owns the accepted outcome',
        '# Complete migration brief',
        '{"acceptance":"initial"}'::jsonb
      )
  `);
  expect(accepted.rows).toEqual([
    {
      accepted_assignment_id: assignmentId,
      accepted_task_id: taskId,
    },
  ]);

  const stored = await database.query<{
    assignment_count: number;
    dispatch_in_request: boolean;
    task_count: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM agentos.tasks WHERE id = '${taskId}')
        AS task_count,
      (
        SELECT count(*)::int
          FROM agentos.task_assignments
         WHERE id = '${assignmentId}'
      ) AS assignment_count,
      (
        SELECT acceptance_request -> 'assignment' ? 'dispatch_profile'
          FROM agentos.task_assignments
         WHERE id = '${assignmentId}'
      ) AS dispatch_in_request
  `);
  expect(stored.rows).toEqual([
    {
      assignment_count: 1,
      dispatch_in_request: false,
      task_count: 1,
    },
  ]);
});
