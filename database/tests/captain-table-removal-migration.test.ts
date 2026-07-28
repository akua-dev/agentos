import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);
const captainId = "10000000-0000-4000-8000-000000000015";
const secondMateId = "20000000-0000-4000-8000-000000000015";
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
    "preserve active Captain rows in the owning Mate's $HOME/MEMORY.md",
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
