import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

const database = await PGlite.create();
const ids = {
  crewA: "20000000-0000-4000-8000-000000000003",
  crewB: "20000000-0000-4000-8000-000000000005",
  firstMate: "20000000-0000-4000-8000-000000000001",
  externalTask: "40000000-0000-4000-8000-000000000004",
  project: "30000000-0000-4000-8000-000000000001",
  secondA: "20000000-0000-4000-8000-000000000002",
  secondB: "20000000-0000-4000-8000-000000000004",
  retirementTask: "40000000-0000-4000-8000-000000000003",
  taskA: "40000000-0000-4000-8000-000000000001",
  taskB: "40000000-0000-4000-8000-000000000002",
};

beforeAll(async () => {
  await database.exec(initialMigration);
  await database.exec(authorizationMigration);
  await database.exec(`
    CREATE ROLE runtime_second_a LOGIN;
    CREATE ROLE runtime_crew_a LOGIN;
    CREATE ROLE runtime_second_b LOGIN;
    CREATE ROLE runtime_crew_b LOGIN;

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES
      ('${ids.firstMate}', 'runtime-first', 'first_mate', NULL, 'pi', 'active', 'First Mate ready'),
      ('${ids.secondA}', 'runtime-second-a', 'second_mate', '${ids.firstMate}', 'pi', 'active', 'Second Mate A ready'),
      ('${ids.crewA}', 'runtime-crew-a', 'crewmate', '${ids.secondA}', 'codex', 'active', 'Crewmate A ready'),
      ('${ids.secondB}', 'runtime-second-b', 'second_mate', '${ids.firstMate}', 'pi', 'active', 'Second Mate B ready'),
      ('${ids.crewB}', 'runtime-crew-b', 'crewmate', '${ids.secondB}', 'codex', 'active', 'Crewmate B ready');

    INSERT INTO agentos.projects (
      id, name, scope_text, status, status_text
    ) VALUES (
      '${ids.project}', 'runtime-authorization',
      'Exercise runtime mutation authorization', 'active', 'Project ready'
    );

    SELECT agentos.register_agent_principal('${ids.firstMate}', 'postgres');
    SELECT agentos.register_agent_principal('${ids.secondA}', 'runtime_second_a');
    SELECT agentos.register_agent_principal('${ids.crewA}', 'runtime_crew_a');
  `);

  await database.exec(runtimeAuthorizationMigration);

  await database.exec(`
    SELECT agentos.register_agent_principal('${ids.secondB}', 'runtime_second_b');
    SELECT agentos.register_agent_principal('${ids.crewB}', 'runtime_crew_b');
  `);
});

afterAll(async () => {
  await database.close();
});

describe.serial("Agent runtime mutation authorization", () => {
  test("lets Mates create and assign work only inside their hierarchy", async () => {
    await asRole("runtime_second_a", async () => {
      await database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, status, status_text
        ) VALUES (
          '${ids.taskA}', '${ids.project}', '${ids.secondA}',
          'Task A', 'active', 'Ready for Crewmate A'
        );
        INSERT INTO agentos.task_assignments (
          task_id, agent_id, assigned_by_agent_id, assignment_role, status,
          status_text
        ) VALUES (
          '${ids.taskA}', '${ids.crewA}', '${ids.secondA}', 'worker', 'assigned',
          'Assigned by Second Mate A'
        );
      `);

      await expect(
        database.exec(`
          INSERT INTO agentos.task_assignments (
            task_id, agent_id, assigned_by_agent_id, assignment_role, status,
            status_text
          ) VALUES (
            '${ids.taskA}', '${ids.crewB}', '${ids.secondA}', 'worker', 'assigned',
            'Attempted cross-tree assignment'
          )
        `),
      ).rejects.toThrow();
    });

    await asRole("runtime_second_b", async () => {
      await database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, status, status_text
        ) VALUES (
          '${ids.taskB}', '${ids.project}', '${ids.secondB}',
          'Task B', 'active', 'Ready for Crewmate B'
        );
      `);
    });

    await asRole("runtime_crew_a", async () => {
      await database.exec(`
        UPDATE agentos.tasks
           SET status = 'in_progress',
               status_text = 'Crewmate A started assigned work'
         WHERE id = '${ids.taskA}'
      `);
      await database.exec(`
        UPDATE agentos.tasks
           SET status_text = 'Crewmate A attempted unrelated work'
         WHERE id = '${ids.taskB}'
      `);
      await expect(
        database.exec(`
          UPDATE agentos.tasks
             SET title = 'Crewmate A rewrote task scope'
           WHERE id = '${ids.taskA}'
        `),
      ).rejects.toThrow();
    });

    const tasks = await database.query<{ id: string; status_text: string }>(`
      SELECT id, status_text
        FROM agentos.tasks
       WHERE id IN ('${ids.taskA}', '${ids.taskB}')
       ORDER BY id
    `);
    expect(tasks.rows).toEqual([
      { id: ids.taskA, status_text: "Crewmate A started assigned work" },
      { id: ids.taskB, status_text: "Ready for Crewmate B" },
    ]);
  });

  test("lets only the authenticated Mate reconcile external events", async () => {
    await asRole("runtime_second_b", async () => {
      await database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, status, status_text
        ) VALUES (
          '${ids.externalTask}', '${ids.project}', '${ids.secondB}',
          'Reconcile external event', 'active', 'Awaiting provider event'
        );
        INSERT INTO agentos.task_assignments (
          task_id, agent_id, assigned_by_agent_id, assignment_role, status,
          status_text
        ) VALUES (
          '${ids.externalTask}', '${ids.crewB}', '${ids.secondB}', 'worker',
          'assigned', 'Crewmate B owns the linked implementation'
        );
      `);
    });

    await database.exec(`
      SELECT agentos.ingest_external_event(
        'github', 'runtime-delivery-1', 'issues.edited',
        'repo:akua/agentos:issue:runtime',
        '{"action":"edited"}'::jsonb,
        'captain', '{}'::jsonb,
        interval '1 millisecond', interval '30 seconds'
      );
      SELECT pg_sleep(0.01);
    `);

    await asRole("runtime_crew_b", async () => {
      await expect(
        database.query(`
          SELECT *
            FROM agentos.claim_external_events('${ids.crewB}', 'github')
        `),
      ).rejects.toThrow();
    });

    await asRole("runtime_second_b", async () => {
      await expect(
        database.query(`
          SELECT *
            FROM agentos.claim_external_events('${ids.secondA}', 'github')
        `),
      ).rejects.toThrow("authenticated Agent identity");

      const claim = await database.query<{ claimed_token: string }>(`
        SELECT claimed_token::text
          FROM agentos.claim_external_events(
            '${ids.secondB}',
            'github',
            'repo:akua/agentos:issue:runtime',
            interval '5 minutes'
          )
      `);
      const claimToken = claim.rows[0]?.claimed_token;
      expect(claimToken).toBeDefined();

      await expect(
        database.exec(`
          UPDATE agentos.external_events
             SET status_text = 'Bypassed the reconciliation functions'
           WHERE claim_token = '${claimToken}'
        `),
      ).rejects.toThrow();

      await database.exec(`
        BEGIN;
        UPDATE agentos.tasks
           SET status = 'completed',
               status_text = 'Reconciled from the current provider state',
               completed_at = transaction_timestamp()
         WHERE id = '${ids.externalTask}';
        SELECT agentos.complete_external_event_claim(
          '${ids.secondB}',
          '${claimToken}',
          '{"outcome":"task-updated"}'::jsonb
        );
        COMMIT;
      `);
    });

    const reconciled = await database.query<{
      reconciliation_status: string;
      task_status: string;
    }>(`
      SELECT e.reconciliation_status, t.status AS task_status
        FROM agentos.external_events AS e
        JOIN agentos.tasks AS t ON t.id = '${ids.externalTask}'
       WHERE e.delivery_id = 'runtime-delivery-1'
    `);
    expect(reconciled.rows).toEqual([
      { reconciliation_status: "reconciled", task_status: "completed" },
    ]);
  });

  test("requires an explicit handoff before retiring an Agent", async () => {
    await asRole("postgres", async () => {
      await expect(
        database.exec(`
          SELECT agentos.retire_agent(
            '${ids.secondA}',
            'Attempted retirement before child handoff'
          )
        `),
      ).rejects.toThrow("active child Agents");
    });

    await asRole("runtime_second_a", async () => {
      await database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, status, status_text
        ) VALUES (
          '${ids.retirementTask}', '${ids.project}', '${ids.secondA}',
          'Retirement handoff', 'active', 'Crewmate A still owns this work'
        );
        INSERT INTO agentos.task_assignments (
          task_id, agent_id, assigned_by_agent_id, assignment_role, status,
          status_text
        ) VALUES (
          '${ids.retirementTask}', '${ids.crewA}', '${ids.secondA}', 'worker',
          'active', 'Assignment must be handed off before retirement'
        );
      `);

      await expect(
        database.exec(`
          SELECT agentos.retire_agent(
            '${ids.crewA}',
            'Retired after completing assigned work'
          )
        `),
      ).rejects.toThrow("active Task assignments");

      await expect(
        database.exec(`
          SELECT agentos.retire_agent(
            '${ids.crewB}',
            'Attempted retirement outside the managed hierarchy'
          )
        `),
      ).rejects.toThrow("managed hierarchy");
    });

    await asRole("runtime_crew_a", async () => {
      await database.exec(`
        UPDATE agentos.task_assignments
           SET status = 'completed',
               status_text = 'Crewmate A completed the assignment',
               started_at = transaction_timestamp(),
               ended_at = transaction_timestamp()
         WHERE agent_id = '${ids.crewA}'
           AND ended_at IS NULL
      `);
    });

    await asRole("runtime_second_a", async () => {
      await expect(
        database.exec(`
          UPDATE agentos.task_assignments
             SET status_text = 'Rewrote completed assignment history'
           WHERE task_id = '${ids.retirementTask}'
             AND agent_id = '${ids.crewA}'
        `),
      ).rejects.toThrow("completed Task assignment is immutable");

      await database.exec(`
        SELECT agentos.retire_agent(
          '${ids.crewA}',
          'Retired after completing assigned work'
        )
      `);
    });

    const retired = await database.query<{
      lifecycle_status: string;
      retired_at: string | null;
      status_text: string;
    }>(`
      SELECT lifecycle_status, retired_at, status_text
        FROM agentos.agents
       WHERE id = '${ids.crewA}'
    `);
    expect(retired.rows[0]?.lifecycle_status).toBe("retired");
    expect(retired.rows[0]?.retired_at).not.toBeNull();
    expect(retired.rows[0]?.status_text).toBe(
      "Retired after completing assigned work",
    );

    await asRole("runtime_crew_a", async () => {
      const visible = await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM agentos.tasks",
      );
      expect(visible.rows[0]?.count).toBe(0);
    });
  });
});

async function asRole<T>(role: string, operation: () => Promise<T>): Promise<T> {
  await database.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await operation();
  } finally {
    await database.exec("SET SESSION AUTHORIZATION postgres");
  }
}
