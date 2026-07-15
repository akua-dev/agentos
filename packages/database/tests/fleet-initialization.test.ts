import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import initialMigration from "../migrations/0000_initial_fleet_schema.sql" with {
  type: "text",
};
import authorizationMigration from "../migrations/0001_agent_authorization.sql" with {
  type: "text",
};
import runtimeAuthorizationMigration from "../migrations/0002_runtime_mutation_authorization.sql" with {
  type: "text",
};
import fleetOwnerMigration from "../migrations/0003_initialize_fleet_owner.sql" with {
  type: "text",
};

test("initializes the Fleet owner as the root First Mate", async () => {
  await usingDatabase(async (database) => {
    await applyPrerequisites(database);
    await database.exec(fleetOwnerMigration);

    const firstMate = await database.query<{
      database_role: string;
      handle: string;
      harness: string;
      id: string;
      lifecycle_status: string;
      parent_agent_id: string | null;
      role: string;
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

    expect(firstMate.rows).toHaveLength(1);
    const root = firstMate.rows[0];
    if (!root) throw new Error("Fleet initialization returned no First Mate");
    expect(root).toMatchObject({
      database_role: "postgres",
      handle: "firstmate",
      harness: "pi",
      lifecycle_status: "active",
      parent_agent_id: null,
      role: "first_mate",
    });

    const identity = await database.query<{
      id: string;
      role: string;
    }>(`
      SELECT
        agentos.current_agent_id()::text AS id,
        agentos.current_agent_role() AS role
    `);
    expect(identity.rows[0]).toEqual({
      id: root.id,
      role: "first_mate",
    });
  });
});

test("adopts an existing unbound First Mate without replacing it", async () => {
  await usingDatabase(async (database) => {
    const existingId = "50000000-0000-4000-8000-000000000001";
    await applyPrerequisites(database);
    await database.exec(`
      INSERT INTO agentos.agents (
        id, handle, display_name, role, harness, lifecycle_status, status_text
      ) VALUES (
        '${existingId}', 'established-first', 'Established First Mate',
        'first_mate', 'pi', 'active', 'Existing runtime awaiting owner binding'
      )
    `);

    await database.exec(fleetOwnerMigration);

    const firstMates = await database.query<{
      database_role: string;
      handle: string;
      id: string;
    }>(`
      SELECT id, handle, database_role::text
        FROM agentos.agents
       WHERE role = 'first_mate'
         AND retired_at IS NULL
    `);
    expect(firstMates.rows).toEqual([
      {
        database_role: "postgres",
        handle: "established-first",
        id: existingId,
      },
    ]);
  });
});

test("fails closed when active First Mate identity is ambiguous", async () => {
  await usingDatabase(async (database) => {
    await applyPrerequisites(database);
    await database.exec(`
      INSERT INTO agentos.agents (
        handle, role, harness, lifecycle_status, status_text
      ) VALUES
        ('ambiguous-first-a', 'first_mate', 'pi', 'active', 'First candidate'),
        ('ambiguous-first-b', 'first_mate', 'pi', 'active', 'Second candidate')
    `);

    await expect(database.exec(fleetOwnerMigration)).rejects.toThrow(
      "multiple active First Mates",
    );
  });
});

test("requires migrations to use the Fleet owner login", async () => {
  await usingDatabase(async (database) => {
    await applyPrerequisites(database);
    await database.exec("CREATE ROLE separate_migrator LOGIN");
    await database.exec("SET SESSION AUTHORIZATION separate_migrator");
    try {
      await expect(database.exec(fleetOwnerMigration)).rejects.toThrow(
        "must run as Fleet owner postgres",
      );
    } finally {
      await database.exec("SET SESSION AUTHORIZATION postgres");
    }
  });
});

test("rejects an existing First Mate bound to another login", async () => {
  await usingDatabase(async (database) => {
    await applyPrerequisites(database);
    await database.exec(`
      CREATE ROLE wrong_first_mate_login LOGIN;
      INSERT INTO agentos.agents (
        handle, role, harness, lifecycle_status, status_text, database_role
      ) VALUES (
        'wrongly-bound-first', 'first_mate', 'pi', 'active',
        'Existing identity has the wrong database login',
        'wrong_first_mate_login'
      )
    `);

    await expect(database.exec(fleetOwnerMigration)).rejects.toThrow(
      "bound to wrong_first_mate_login, expected Fleet owner postgres",
    );
  });
});

test("keeps one active First Mate as the Fleet root", async () => {
  await usingDatabase(async (database) => {
    await applyPrerequisites(database);
    await database.exec(fleetOwnerMigration);

    await expect(
      database.exec(`
        INSERT INTO agentos.agents (
          handle, role, harness, lifecycle_status, status_text
        ) VALUES (
          'competing-first', 'first_mate', 'pi', 'active',
          'Attempted competing Fleet root'
        )
      `),
    ).rejects.toThrow();
  });
});

async function applyPrerequisites(database: PGlite) {
  await database.exec(initialMigration);
  await database.exec(authorizationMigration);
  await database.exec(runtimeAuthorizationMigration);
}

async function usingDatabase(operation: (database: PGlite) => Promise<void>) {
  const database = await PGlite.create();
  try {
    await operation(database);
  } finally {
    await database.close();
  }
}
