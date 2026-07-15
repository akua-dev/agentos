import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import initialMigration from "../migrations/0000_initial_fleet_schema.sql" with {
  type: "text",
};
import authorizationMigration from "../migrations/0001_agent_authorization.sql" with {
  type: "text",
};

const database = await PGlite.create();
const ids = {
  crewmate: "00000000-0000-4000-8000-000000000003",
  firstMate: "00000000-0000-4000-8000-000000000001",
  secondMate: "00000000-0000-4000-8000-000000000002",
};

beforeAll(async () => {
  await database.exec(initialMigration);
  await database.exec(authorizationMigration);
  await database.exec(`
    CREATE ROLE test_first_mate LOGIN;
    CREATE ROLE test_second_mate LOGIN;
    CREATE ROLE test_crewmate LOGIN;
    CREATE ROLE test_outsider LOGIN;

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES
      ('${ids.firstMate}', 'first', 'first_mate', NULL, 'pi', 'active', 'First Mate ready'),
      ('${ids.secondMate}', 'second', 'second_mate', '${ids.firstMate}', 'pi', 'active', 'Second Mate ready'),
      ('${ids.crewmate}', 'crew', 'crewmate', '${ids.secondMate}', 'codex', 'active', 'Crewmate ready');

    SELECT agentos.register_agent_principal('${ids.firstMate}', 'test_first_mate');
    SELECT agentos.register_agent_principal('${ids.secondMate}', 'test_second_mate');
    SELECT agentos.register_agent_principal('${ids.crewmate}', 'test_crewmate');
  `);
});

afterAll(async () => {
  await database.close();
});

describe.serial("agent database authorization", () => {
  test("keeps unmapped database roles outside the AgentOS schema", async () => {
    await expect(
      asRole("test_outsider", () =>
        database.query("SELECT count(*) FROM agentos.agents"),
      ),
    ).rejects.toThrow();
  });

  test("gives every active Agent an unfiltered Fleet read view", async () => {
    await database.exec(`
      INSERT INTO agentos.projects (
        name, scope_text, status, status_text
      ) VALUES (
        'authorization', 'Exercise Fleet-wide reads', 'active', 'Project is readable'
      );
      INSERT INTO agentos.captain (
        topic, content, recorded_by_agent_id
      ) VALUES (
        'visibility', 'All active Agents may read Fleet state', '${ids.firstMate}'
      );
      INSERT INTO agentos.tasks (
        created_by_agent_id, title, status, status_text
      ) VALUES (
        '${ids.firstMate}', 'Verify Fleet reads', 'active', 'Authorization is under test'
      );
      INSERT INTO agentos.task_assignments (
        task_id, agent_id, assigned_by_agent_id, assignment_role, status, status_text
      )
      SELECT
        t.id, '${ids.crewmate}', '${ids.secondMate}', 'worker', 'active',
        'Crewmate owns the verification assignment'
      FROM agentos.tasks AS t
      WHERE t.title = 'Verify Fleet reads';
      INSERT INTO agentos.learnings (
        recorded_by_agent_id, scope, topic, content
      ) VALUES (
        '${ids.crewmate}', 'fleet', 'authorization', 'Read access is Fleet-wide'
      );
      SELECT agentos.ingest_external_event(
        'github', 'authorization-delivery', 'issues.edited',
        'repo:akua/agentos:issue:1', '{"action":"edited"}'::jsonb
      );
    `);

    await asRole("test_crewmate", async () => {
      const expectedCounts: Record<string, number> = {
        agents: 3,
        captain: 1,
        external_events: 1,
        inbox: 0,
        learnings: 1,
        projects: 1,
        task_assignments: 1,
        tasks: 1,
      };

      for (const [table, expectedCount] of Object.entries(expectedCounts)) {
        const result = await database.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM agentos.${table}`,
        );
        expect(result.rows[0]?.count).toBe(expectedCount);
      }
    });
  });

  test("limits Agent updates to their managed hierarchy", async () => {
    await asRole("test_crewmate", async () => {
      const visible = await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM agentos.agents",
      );
      expect(visible.rows[0]?.count).toBe(3);

      await database.exec(`
        UPDATE agentos.agents
           SET status_text = 'Crewmate updated itself'
         WHERE id = '${ids.crewmate}'
      `);
      await database.exec(`
        UPDATE agentos.agents
           SET status_text = 'Crewmate tried to update its parent'
         WHERE id = '${ids.secondMate}'
      `);
      await expect(
        database.exec(`
          UPDATE agentos.agents
             SET role = 'second_mate'
           WHERE id = '${ids.crewmate}'
        `),
      ).rejects.toThrow();
    });

    await asRole("test_second_mate", async () => {
      await database.exec(`
        UPDATE agentos.agents
           SET status_text = 'Second Mate updated its child'
         WHERE id = '${ids.crewmate}'
      `);
      await database.exec(`
        UPDATE agentos.agents
           SET status_text = 'Second Mate tried to update First Mate'
         WHERE id = '${ids.firstMate}'
      `);
    });

    const statuses = await database.query<{ id: string; status_text: string }>(`
      SELECT id, status_text
        FROM agentos.agents
       WHERE id IN ('${ids.firstMate}', '${ids.secondMate}', '${ids.crewmate}')
       ORDER BY id
    `);
    expect(statuses.rows).toEqual([
      { id: ids.firstMate, status_text: "First Mate ready" },
      { id: ids.secondMate, status_text: "Second Mate ready" },
      { id: ids.crewmate, status_text: "Second Mate updated its child" },
    ]);
  });

  test("keeps Inbox fully readable and sender-authentic", async () => {
    const firstToCrew = "10000000-0000-4000-8000-000000000001";
    const firstToSecond = "10000000-0000-4000-8000-000000000002";
    const crewToFirst = "10000000-0000-4000-8000-000000000003";

    await asRole("test_first_mate", async () => {
      await database.exec(`
        INSERT INTO agentos.inbox (
          id, sender_agent_id, sender_label, recipient_agent_id, kind,
          body, decision_key, status, status_text
        ) VALUES
          ('${firstToCrew}', '${ids.firstMate}', 'first', '${ids.crewmate}',
           'request', 'Original request', 'first-to-crew', 'unread', 'Awaiting Crewmate'),
          ('${firstToSecond}', '${ids.firstMate}', 'first', '${ids.secondMate}',
           'private', 'Second Mate only', 'first-to-second', 'unread', 'Awaiting Second Mate')
      `);
    });

    await asRole("test_crewmate", async () => {
      const visible = await database.query<{ decision_key: string }>(`
        SELECT decision_key
          FROM agentos.inbox
         ORDER BY decision_key
      `);
      expect(visible.rows).toEqual([
        { decision_key: "first-to-crew" },
        { decision_key: "first-to-second" },
      ]);

      await expect(
        database.exec(`
          UPDATE agentos.inbox
             SET body = 'Recipient rewrote the sender content'
           WHERE id = '${firstToCrew}'
        `),
      ).rejects.toThrow();

      await database.exec(`
        UPDATE agentos.inbox
           SET read_at = transaction_timestamp(),
               status = 'read',
               status_text = 'Crewmate read the request'
         WHERE id = '${firstToCrew}'
      `);

      await expect(
        database.exec(`
          INSERT INTO agentos.inbox (
            sender_agent_id, sender_label, recipient_agent_id, kind, body,
            status, status_text
          ) VALUES (
            '${ids.secondMate}', 'second', '${ids.firstMate}', 'spoof',
            'Pretending to be Second Mate', 'unread', 'Spoofed sender'
          )
        `),
      ).rejects.toThrow();

      await database.exec(`
        INSERT INTO agentos.inbox (
          id, sender_agent_id, sender_label, recipient_agent_id, kind, body,
          status, status_text
        ) VALUES (
          '${crewToFirst}', '${ids.crewmate}', 'crew', '${ids.firstMate}',
          'reply', 'Initial reply', 'unread', 'Draft reply'
        )
      `);
      await database.exec(`
        UPDATE agentos.inbox
           SET body = 'Edited before First Mate read it'
         WHERE id = '${crewToFirst}'
      `);
    });

    await asRole("test_first_mate", async () => {
      await expect(
        database.exec(`
          UPDATE agentos.inbox
             SET body = 'Sender rewrote content after it was read'
           WHERE id = '${firstToCrew}'
        `),
      ).rejects.toThrow();
    });

    await asRole("test_second_mate", async () => {
      const visible = await database.query<{ decision_key: string | null }>(`
        SELECT decision_key
          FROM agentos.inbox
         ORDER BY decision_key NULLS LAST
      `);
      expect(visible.rows).toEqual([
        { decision_key: "first-to-crew" },
        { decision_key: "first-to-second" },
        { decision_key: null },
      ]);
    });
  });

  test("rejects a login that inherits a PostgreSQL bypass role", async () => {
    const inheritedAgent = "00000000-0000-4000-8000-000000000004";
    await database.exec(`
      CREATE ROLE test_bypass NOLOGIN BYPASSRLS;
      CREATE ROLE test_inherited LOGIN;
      GRANT test_bypass TO test_inherited;
      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES (
        '${inheritedAgent}', 'inherited', 'crewmate', '${ids.secondMate}',
        'codex', 'active', 'Awaiting a safe database principal'
      )
    `);

    await expect(
      database.exec(`
        SELECT agentos.register_agent_principal(
          '${inheritedAgent}', 'test_inherited'
        )
      `),
    ).rejects.toThrow("too privileged");
  });

  test("removes a retired Agent from the runtime authorization boundary", async () => {
    await database.exec(`
      UPDATE agentos.agents
         SET retired_at = transaction_timestamp(),
             lifecycle_status = 'retired',
             status_text = 'Retired by Fleet owner'
       WHERE id = '${ids.crewmate}'
    `);

    await asRole("test_crewmate", async () => {
      for (const table of [
        "agents",
        "captain",
        "external_events",
        "inbox",
        "learnings",
        "projects",
        "task_assignments",
        "tasks",
      ]) {
        const result = await database.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM agentos.${table}`,
        );
        expect(result.rows[0]?.count).toBe(0);
      }
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
