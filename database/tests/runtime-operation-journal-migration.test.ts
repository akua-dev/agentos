import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);
const ids = {
  crewBefore: "26000000-0000-4000-8000-000000000003",
  crewAfter: "26000000-0000-4000-8000-000000000004",
  firstMate: "",
  operation: "76000000-0000-4000-8000-000000000001",
  secondMate: "26000000-0000-4000-8000-000000000002",
};

beforeAll(async () => {
  const files = (await readdir(migrationsDirectory))
    .filter(
      (file) =>
        /^\d+_.+\.sql$/.test(file) && Number.parseInt(file, 10) <= 16,
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
  ids.firstMate = root.rows[0]!.id;

  await database.exec(`
    CREATE ROLE journal_upgrade_second LOGIN;
    CREATE ROLE journal_upgrade_crew_before LOGIN;
    CREATE ROLE journal_upgrade_crew_after LOGIN;

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES
      (
        '${ids.secondMate}', 'journal-upgrade-second', 'second_mate',
        '${ids.firstMate}', 'pi', 'active', 'Second Mate predates migration'
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

  const migration = await import(
    new URL("0017_runtime_operation_journal.sql", migrationsDirectory).href,
    { with: { type: "text" } },
  );
  await database.exec(migration.default);
});

afterAll(async () => {
  await database.close();
});

test("upgrades existing principals and configures principals registered later", async () => {
  await asLogin("journal_upgrade_second", async () => {
    const begun = await database.query<{ id: string }>(`
      SELECT agentos.begin_runtime_operation(
        '${ids.operation}', '${ids.crewBefore}', NULL,
        'agentos-upgrade-domain', 'journal-upgrade-crew-before', 'provision',
        '${"d".repeat(64)}', '[]'::jsonb
      )::text AS id
    `);
    expect(begun.rows).toEqual([{ id: ids.operation }]);
  });

  await asLogin("journal_upgrade_crew_before", async () => {
    const visible = await database.query<{ phase: string }>(`
      SELECT phase
        FROM agentos.runtime_operations
       WHERE id = '${ids.operation}'
    `);
    expect(visible.rows).toEqual([{ phase: "prepared" }]);
    await expect(
      database.query(`
        SELECT agentos.begin_runtime_operation(
          gen_random_uuid(), '${ids.crewBefore}', NULL,
          'agentos-upgrade-domain', 'journal-upgrade-crew-before', 'recover',
          '${"e".repeat(64)}', '[]'::jsonb
        )
      `),
    ).rejects.toThrow();
  });

  await database.exec(`
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

  await asLogin("journal_upgrade_crew_after", async () => {
    const visible = await database.query<{ id: string }>(`
      SELECT id::text
        FROM agentos.runtime_operations
       WHERE id = '${ids.operation}'
    `);
    expect(visible.rows).toEqual([{ id: ids.operation }]);
    await expect(
      database.exec(`
        UPDATE agentos.runtime_operations
           SET phase = 'failed'
         WHERE id = '${ids.operation}'
      `),
    ).rejects.toThrow();
  });
});

async function asLogin<T>(
  role: string,
  operation: () => Promise<T>,
): Promise<T> {
  await database.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await operation();
  } finally {
    await database.exec("SET SESSION AUTHORIZATION postgres");
  }
}
