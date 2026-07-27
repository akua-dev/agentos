import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);

const ids = {
  backlogAssignment: "51000000-0000-4000-8000-000000000003",
  backlogTask: "41000000-0000-4000-8000-000000000003",
  crewA: "21000000-0000-4000-8000-000000000003",
  crewB: "21000000-0000-4000-8000-000000000005",
  firstAssignment: "51000000-0000-4000-8000-000000000001",
  firstMate: "",
  firstTask: "41000000-0000-4000-8000-000000000001",
  historicalAssignment: "51000000-0000-4000-8000-000000000004",
  historicalTask: "41000000-0000-4000-8000-000000000004",
  invalidAssignment: "51000000-0000-4000-8000-000000000002",
  invalidTask: "41000000-0000-4000-8000-000000000002",
  project: "31000000-0000-4000-8000-000000000001",
  replacementCrew: "21000000-0000-4000-8000-000000000006",
  secondA: "21000000-0000-4000-8000-000000000002",
  secondB: "21000000-0000-4000-8000-000000000004",
};

beforeAll(async () => {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
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
    CREATE ROLE acceptance_second_a LOGIN;
    CREATE ROLE acceptance_crew_a LOGIN;
    CREATE ROLE acceptance_second_b LOGIN;
    CREATE ROLE acceptance_crew_b LOGIN;
    CREATE ROLE acceptance_unregistered LOGIN;

    INSERT INTO agentos.projects (
      id, name, scope_text, status, status_text
    ) VALUES (
      '${ids.project}', 'atomic-acceptance',
      'Exercise atomic Task acceptance', 'active', 'Project ready'
    );

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES
      (
        '${ids.secondA}', 'acceptance-second-a', 'second_mate',
        '${ids.firstMate}', 'pi', 'active', 'Second Mate A ready'
      ),
      (
        '${ids.crewA}', 'acceptance-crew-a', 'crewmate',
        '${ids.secondA}', 'codex', 'active', 'Crewmate A ready'
      ),
      (
        '${ids.secondB}', 'acceptance-second-b', 'second_mate',
        '${ids.firstMate}', 'pi', 'active', 'Second Mate B ready'
      ),
      (
        '${ids.crewB}', 'acceptance-crew-b', 'crewmate',
        '${ids.secondB}', 'codex', 'active', 'Crewmate B ready'
      ),
      (
        '${ids.replacementCrew}', 'acceptance-replacement', 'crewmate',
        '${ids.secondA}', 'codex', 'active', 'Replacement ready'
      );

    SELECT agentos.register_agent_principal(
      '${ids.secondA}', 'acceptance_second_a'
    );
    SELECT agentos.register_agent_principal(
      '${ids.crewA}', 'acceptance_crew_a'
    );
    SELECT agentos.register_agent_principal(
      '${ids.secondB}', 'acceptance_second_b'
    );
    SELECT agentos.register_agent_principal(
      '${ids.crewB}', 'acceptance_crew_b'
    );
  `);
});

afterAll(async () => {
  await database.close();
});

describe.serial("atomic Task acceptance", () => {
  test("creates one Task and first Assignment and retries from immutable acceptance input", async () => {
    await asRole("acceptance_second_a", async () => {
      const accepted = await createAcceptedTask();
      expect(accepted.rows).toEqual([
        {
          accepted_assignment_id: ids.firstAssignment,
          accepted_task_id: ids.firstTask,
        },
      ]);

      await database.exec(`
        UPDATE agentos.tasks
           SET status = 'in_progress',
               status_text = 'Crewmate started after acceptance'
         WHERE id = '${ids.firstTask}'
      `);

      const retried = await createAcceptedTask();
      expect(retried.rows).toEqual(accepted.rows);

      await expect(
        createAcceptedTask({ title: "Conflicting reuse" }),
      ).rejects.toThrow("conflicts with the original acceptance request");

      await expect(
        createAcceptedTask({
          assignmentId: ids.firstAssignment,
          taskId: "41000000-0000-4000-8000-000000000099",
        }),
      ).rejects.toThrow("conflicts with the original acceptance request");
    });

    const stored = await database.query<{
      assignments: number;
      request_actor: string;
      tasks: number;
    }>(`
      SELECT
        (SELECT count(*)::int
           FROM agentos.tasks
          WHERE id = '${ids.firstTask}') AS tasks,
        (SELECT count(*)::int
           FROM agentos.task_assignments
          WHERE id = '${ids.firstAssignment}') AS assignments,
        (SELECT acceptance_request ->> 'actor_id'
           FROM agentos.task_assignments
          WHERE id = '${ids.firstAssignment}') AS request_actor
    `);
    expect(stored.rows).toEqual([
      {
        assignments: 1,
        request_actor: ids.secondA,
        tasks: 1,
      },
    ]);

    await expect(
      database.exec(`
        UPDATE agentos.task_assignments
           SET acceptance_request = '{}'::jsonb
         WHERE id = '${ids.firstAssignment}'
      `),
    ).rejects.toThrow("acceptance request is immutable");
  });

  test("keeps Fleet-owner acceptance available to First Mate", async () => {
    const accepted = await createAcceptedTask({
      agentId: ids.crewB,
      assignmentId: "51000000-0000-4000-8000-000000000010",
      taskId: "41000000-0000-4000-8000-000000000010",
      title: "First Mate accepted outcome",
    });
    expect(accepted.rows).toEqual([
      {
        accepted_assignment_id: "51000000-0000-4000-8000-000000000010",
        accepted_task_id: "41000000-0000-4000-8000-000000000010",
      },
    ]);

    const actor = await database.query<{ actor_id: string }>(`
      SELECT acceptance_request ->> 'actor_id' AS actor_id
        FROM agentos.task_assignments
       WHERE id = '51000000-0000-4000-8000-000000000010'
    `);
    expect(actor.rows[0]!.actor_id).toBe(ids.firstMate);
  });

  test("lets a Second Mate record backlog but denies raw Assignment acceptance", async () => {
    await asRole("acceptance_second_a", async () => {
      await database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, status, status_text
        ) VALUES (
          '41000000-0000-4000-8000-000000000030',
          '${ids.project}', '${ids.secondA}', 'Deliberate raw backlog',
          'queued', 'Not accepted until the released Function runs'
        )
      `);

      await expect(
        database.exec(`
          INSERT INTO agentos.task_assignments (
            id, task_id, agent_id, assigned_by_agent_id, assignment_role,
            status, status_text, brief, dispatch_profile
          ) VALUES (
            '51000000-0000-4000-8000-000000000030',
            '41000000-0000-4000-8000-000000000030',
            '${ids.crewA}', '${ids.secondA}', 'ship', 'assigned',
            'Attempted non-atomic acceptance', '# Raw acceptance brief',
            '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb
          )
        `),
      ).rejects.toThrow();
    });

    const ownership = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count
        FROM agentos.task_assignments
       WHERE task_id = '41000000-0000-4000-8000-000000000030'
    `);
    expect(ownership.rows[0]!.count).toBe(0);
  });

  test("rolls back invalid input and rejects unauthorized destinations and callers", async () => {
    await asRole("acceptance_second_a", async () => {
      await expect(
        createAcceptedTask({
          assignmentId: ids.invalidAssignment,
          dispatchProfile:
            '{"version":1,"harness":"pi","materials":[],"settings":{}}',
          taskId: ids.invalidTask,
        }),
      ).rejects.toThrow("composition harness must match the assigned Agent");

      await expect(
        createAcceptedTask({
          assignmentId: "51000000-0000-4000-8000-000000000020",
          agentId: ids.crewB,
          taskId: "41000000-0000-4000-8000-000000000020",
        }),
      ).rejects.toThrow("managed hierarchy");
    });

    const invalidRows = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count
        FROM agentos.tasks
       WHERE id IN ('${ids.invalidTask}', '41000000-0000-4000-8000-000000000020')
    `);
    expect(invalidRows.rows[0]!.count).toBe(0);

    await asRole("acceptance_crew_a", async () => {
      await expect(
        createAcceptedTask({
          assignmentId: "51000000-0000-4000-8000-000000000021",
          taskId: "41000000-0000-4000-8000-000000000021",
        }),
      ).rejects.toThrow();
      await expect(
        acceptBacklogTask(ids.backlogTask, ids.backlogAssignment),
      ).rejects.toThrow();
    });

    await asRole("acceptance_unregistered", async () => {
      await expect(
        createAcceptedTask({
          assignmentId: "51000000-0000-4000-8000-000000000022",
          taskId: "41000000-0000-4000-8000-000000000022",
        }),
      ).rejects.toThrow();
    });
  });

  test("accepts deliberately recorded backlog once and retries after state advances", async () => {
    await database.exec(`
      INSERT INTO agentos.tasks (
        id, project_id, created_by_agent_id, title, description,
        status, status_text, priority
      ) VALUES (
        '${ids.backlogTask}', '${ids.project}', '${ids.secondA}',
        'Recorded backlog outcome', 'Accept this only when capacity is ready',
        'queued', 'Waiting in deliberate backlog', 'normal'
      )
    `);

    await asRole("acceptance_second_a", async () => {
      const accepted = await acceptBacklogTask(
        ids.backlogTask,
        ids.backlogAssignment,
      );
      expect(accepted.rows).toEqual([
        {
          accepted_assignment_id: ids.backlogAssignment,
          accepted_task_id: ids.backlogTask,
        },
      ]);

      await database.exec(`
        UPDATE agentos.tasks
           SET status = 'in_progress',
               status_text = 'Accepted backlog work started'
         WHERE id = '${ids.backlogTask}'
      `);

      const retried = await acceptBacklogTask(
        ids.backlogTask,
        ids.backlogAssignment,
      );
      expect(retried.rows).toEqual(accepted.rows);
    });
  });

  test("rejects backlog with Assignment history and enforces one active owner", async () => {
    await database.exec(`
      INSERT INTO agentos.tasks (
        id, project_id, created_by_agent_id, title, status, status_text
      ) VALUES (
        '${ids.historicalTask}', '${ids.project}', '${ids.secondA}',
        'Historical work', 'active', 'Previously accepted'
      );
      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, brief, dispatch_profile
      ) VALUES (
        '${ids.historicalAssignment}', '${ids.historicalTask}', '${ids.crewA}',
        '${ids.secondA}', 'ship', 'assigned', 'Original owner',
        '# Historical brief',
        '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb
      );
      UPDATE agentos.task_assignments
         SET status = 'completed',
             status_text = 'Historical assignment completed',
             report = 'The historical assignment ended.',
             ended_at = transaction_timestamp()
       WHERE id = '${ids.historicalAssignment}';
    `);

    await asRole("acceptance_second_a", async () => {
      await expect(
        acceptBacklogTask(
          ids.historicalTask,
          "51000000-0000-4000-8000-000000000023",
        ),
      ).rejects.toThrow("has Assignment history");
    });

    await expect(
      database.exec(`
        INSERT INTO agentos.task_assignments (
          id, task_id, agent_id, assigned_by_agent_id, assignment_role,
          status, status_text, brief, dispatch_profile
        ) VALUES (
          '51000000-0000-4000-8000-000000000024',
          '${ids.firstTask}', '${ids.replacementCrew}', '${ids.secondA}',
          'ship', 'assigned', 'Invalid concurrent owner',
          '# Concurrent brief',
          '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb
        )
      `),
    ).rejects.toThrow(
      'duplicate key value violates unique constraint "task_assignments_one_active_owner_idx"',
    );

    await asRole("acceptance_second_a", async () => {
      const handoff = await database.query<{ id: string }>(`
        SELECT agentos.handoff_task_assignment(
          '${ids.firstAssignment}',
          '${ids.replacementCrew}',
          '# Replacement brief',
          'The first owner preserved its findings.',
          'Transferred to the replacement owner',
          '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb
        )::text AS id
      `);

      const active = await database.query<{
        agent_id: string;
        count: number;
        id: string;
      }>(`
        SELECT count(*)::int AS count,
               min(id::text) AS id,
               min(agent_id::text) AS agent_id
          FROM agentos.task_assignments
         WHERE task_id = '${ids.firstTask}'
           AND ended_at IS NULL
      `);
      expect(active.rows).toEqual([
        {
          agent_id: ids.replacementCrew,
          count: 1,
          id: handoff.rows[0]!.id,
        },
      ]);
    });
  });
});

function createAcceptedTask(
  overrides: {
    agentId?: string;
    assignmentId?: string;
    dispatchProfile?: string;
    taskId?: string;
    title?: string;
  } = {},
) {
  const agentId = overrides.agentId ?? ids.crewA;
  const assignmentId = overrides.assignmentId ?? ids.firstAssignment;
  const dispatchProfile =
    overrides.dispatchProfile ??
    '{"version":1,"harness":"codex","materials":[],"settings":{}}';
  const taskId = overrides.taskId ?? ids.firstTask;
  const title = overrides.title ?? "Implement atomic acceptance";

  return database.query<{
    accepted_assignment_id: string;
    accepted_task_id: string;
  }>(`
    SELECT accepted_task_id::text, accepted_assignment_id::text
      FROM agentos.create_task_with_assignment(
        '${taskId}',
        '${assignmentId}',
        '${agentId}',
        '${ids.project}',
        NULL,
        '${title}',
        'Create one accepted outcome.',
        'active',
        'Accepted by the owning Mate',
        'high',
        '[]'::jsonb,
        '[]'::jsonb,
        '{"source":"captain"}'::jsonb,
        'ship',
        'assigned',
        'Crewmate owns the accepted outcome',
        '# Complete brief',
        '${dispatchProfile}'::jsonb,
        '{"acceptance":"initial"}'::jsonb
      )
  `);
}

function acceptBacklogTask(taskId: string, assignmentId: string) {
  return database.query<{
    accepted_assignment_id: string;
    accepted_task_id: string;
  }>(`
    SELECT accepted_task_id::text, accepted_assignment_id::text
      FROM agentos.accept_backlog_task(
        '${taskId}',
        '${assignmentId}',
        '${ids.crewA}',
        'active',
        'Accepted from deliberate backlog',
        'ship',
        'assigned',
        'Crewmate owns the accepted backlog outcome',
        '# Backlog acceptance brief',
        '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb,
        '{"acceptance":"backlog"}'::jsonb
      )
  `);
}

async function asRole<T>(role: string, operation: () => Promise<T>): Promise<T> {
  await database.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await operation();
  } finally {
    await database.exec("SET SESSION AUTHORIZATION postgres");
  }
}
