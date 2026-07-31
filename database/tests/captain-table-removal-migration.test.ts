import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);
const captainId = "10000000-0000-4000-8000-000000000015";
const secondMateId = "20000000-0000-4000-8000-000000000015";
const taskId = "40000000-0000-4000-8000-000000000015";
const assignmentId = "50000000-0000-4000-8000-000000000015";
let firstMateId = "";

beforeAll(async () => {
  const files = (await readdir(migrationsDirectory))
    .filter(
      (file) =>
        /^\d+_.+\.sql$/.test(file) && Number.parseInt(file, 10) <= 14,
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
});

afterAll(async () => {
  await database.close();
});

test("refuses active Captain state, then removes the table after explicit archival", async () => {
  const migration = await import(
    new URL("0015_mate_memory.sql", migrationsDirectory).href,
    { with: { type: "text" } },
  );

  await expect(database.exec(migration.default)).rejects.toThrow(
    "preserve active Captain rows in the owning Mate's $HOME/memory/",
  );

  const preserved = await database.query<{
    content: string;
    relation: string | null;
  }>(`
    SELECT
      to_regclass('agentos.captain')::text AS relation,
      content
      FROM agentos.captain
     WHERE id = '${captainId}'
  `);
  expect(preserved.rows).toEqual([
    {
      content:
        "Lead with the outcome on the primary Captain surface.",
      relation: "agentos.captain",
    },
  ]);

  await database.exec(`
    UPDATE agentos.captain
       SET archived_at = transaction_timestamp()
     WHERE id = '${captainId}'
  `);
  await database.exec(migration.default);

  const removed = await database.query<{ relation: string | null }>(`
    SELECT to_regclass('agentos.captain')::text AS relation
  `);
  expect(removed.rows[0]!.relation).toBeNull();

  const existingWork = await database.query<{
    assignment_status: string;
    task_status: string;
  }>(`
    SELECT
      assignment.status AS assignment_status,
      task.status AS task_status
      FROM agentos.task_assignments AS assignment
      JOIN agentos.tasks AS task ON task.id = assignment.task_id
     WHERE assignment.id = '${assignmentId}'
  `);
  expect(existingWork.rows).toEqual([
    { assignment_status: "active", task_status: "active" },
  ]);

  await database.exec(`
    SELECT agentos.register_agent_principal(
      '${secondMateId}',
      'memory_migration_second'
    );
    SELECT agentos.configure_agent_runtime_privileges(
      'memory_migration_second',
      'second_mate'
    );
  `);
});
