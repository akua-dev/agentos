import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);

const ids = {
  crew: "20000000-0000-4000-8000-000000000014",
  destination: "20000000-0000-4000-8000-000000000012",
  firstMate: "20000000-0000-4000-8000-000000000001",
  project: "30000000-0000-4000-8000-000000000001",
  reviewAssignment: "50000000-0000-4000-8000-000000000003",
  reviewTask: "40000000-0000-4000-8000-000000000003",
  scout: "20000000-0000-4000-8000-000000000011",
  secondMate: "20000000-0000-4000-8000-000000000013",
  scoutAssignment: "50000000-0000-4000-8000-000000000001",
  scoutTask: "40000000-0000-4000-8000-000000000001",
  shipAssignment: "50000000-0000-4000-8000-000000000002",
  shipTask: "40000000-0000-4000-8000-000000000002",
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
    CREATE ROLE coordination_second LOGIN;
    CREATE ROLE coordination_crew LOGIN;

    INSERT INTO agentos.projects (
      id, name, scope_text, status, status_text
    ) VALUES (
      '${ids.project}', 'coordination-contracts',
      'Exercise durable Fleet coordination', 'active', 'Project ready'
    );

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES
      (
        '${ids.scout}', 'coordination-scout', 'crewmate', '${ids.firstMate}',
        'codex', 'active', 'Scout ready'
      ),
      (
        '${ids.destination}', 'coordination-destination', 'crewmate', '${ids.firstMate}',
        'codex', 'active', 'Destination ready'
      ),
      (
        '${ids.secondMate}', 'coordination-second', 'second_mate', '${ids.firstMate}',
        'pi', 'active', 'Second Mate ready'
      ),
      (
        '${ids.crew}', 'coordination-crew', 'crewmate', '${ids.secondMate}',
        'codex', 'active', 'Crewmate ready'
      );

    SELECT agentos.register_agent_principal('${ids.secondMate}', 'coordination_second');
    SELECT agentos.register_agent_principal('${ids.crew}', 'coordination_crew');
  `);
});

afterAll(async () => {
  await database.close();
});

describe.serial("durable Fleet coordination contracts", () => {
  test("stores scoped Captain state and explicit Assignment artifacts", async () => {
    const columns = await database.query<{ column_name: string }>(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'agentos'
         AND (
           (table_name = 'captain' AND column_name IN ('scope', 'scope_agent_id'))
           OR
           (table_name = 'task_assignments' AND column_name IN (
             'brief', 'report', 'dispatch_profile', 'supersedes_assignment_id',
             'decision_keys', 'decisions_attested_at', 'decisions_attested_by_agent_id'
           ))
         )
       ORDER BY table_name, ordinal_position
    `);

    expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
      "scope",
      "scope_agent_id",
      "brief",
      "report",
      "dispatch_profile",
      "supersedes_assignment_id",
      "decision_keys",
      "decisions_attested_at",
      "decisions_attested_by_agent_id",
    ]);

    await expect(
      database.exec(`
        INSERT INTO agentos.captain (topic, content, scope, scope_agent_id)
        VALUES ('invalid scope', 'Must be rejected', 'fleet', '${ids.scout}')
      `),
    ).rejects.toThrow();
  });

  test("keeps Captain rows fully readable while Second Mate writes only its domain", async () => {
    await database.exec(`
      INSERT INTO agentos.captain (topic, content, scope)
      VALUES ('fleet-policy', 'Use the reviewed project workflow', 'fleet')
    `);

    await asRole("coordination_second", async () => {
      await database.exec(`
        INSERT INTO agentos.captain (
          topic, content, recorded_by_agent_id, scope, scope_agent_id
        ) VALUES (
          'domain-policy', 'Prefer focused delivery reports', '${ids.secondMate}',
          'agent', '${ids.secondMate}'
        )
      `);

      const visible = await database.query<{ topic: string }>(`
        SELECT topic FROM agentos.captain ORDER BY topic
      `);
      expect(visible.rows.map(({ topic }) => topic)).toEqual([
        "domain-policy",
        "fleet-policy",
      ]);

      await expect(
        database.exec(`
          INSERT INTO agentos.captain (
            topic, content, recorded_by_agent_id, scope
          ) VALUES (
            'unauthorized-fleet-policy', 'Must fail', '${ids.secondMate}', 'fleet'
          )
        `),
      ).rejects.toThrow();
    });

    await asRole("coordination_crew", async () => {
      const visible = await database.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM agentos.captain
      `);
      expect(visible.rows[0]!.count).toBe(2);

      await expect(
        database.exec(`
          INSERT INTO agentos.captain (
            topic, content, recorded_by_agent_id, scope, scope_agent_id
          ) VALUES (
            'crew-policy', 'Must fail', '${ids.crew}', 'agent', '${ids.crew}'
          )
        `),
      ).rejects.toThrow();
    });
  });

  test("requires a complete brief before dispatch and a report before ending", async () => {
    await database.exec(`
      INSERT INTO agentos.tasks (
        id, project_id, created_by_agent_id, title, status, status_text
      ) VALUES (
        '${ids.shipTask}', '${ids.project}', '${ids.firstMate}',
        'Deliver a bounded change', 'active', 'Ready to assign'
      )
    `);

    await expect(
      database.exec(`
        INSERT INTO agentos.task_assignments (
          id, task_id, agent_id, assigned_by_agent_id, assignment_role,
          status, status_text, dispatch_profile
        ) VALUES (
          '${ids.shipAssignment}', '${ids.shipTask}', '${ids.scout}',
          '${ids.firstMate}', 'ship', 'assigned', 'Missing its brief',
          '{"harness":"codex"}'::jsonb
        )
      `),
    ).rejects.toThrow("Task Assignment requires a durable brief");

    await expect(
      database.exec(`
        INSERT INTO agentos.task_assignments (
          id, task_id, agent_id, assigned_by_agent_id, assignment_role,
          status, status_text, brief, dispatch_profile
        ) VALUES (
          '${ids.shipAssignment}', '${ids.shipTask}', '${ids.scout}',
          '${ids.firstMate}', 'ship', 'assigned', 'Mismatched harness profile',
          '# Ship brief', '{"harness":"pi"}'::jsonb
        )
      `),
    ).rejects.toThrow("dispatch-profile harness must match the assigned Agent");

    await database.exec(`
      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, brief, dispatch_profile, started_at
      ) VALUES (
        '${ids.shipAssignment}', '${ids.shipTask}', '${ids.scout}',
        '${ids.firstMate}', 'ship', 'active', 'Implementation started',
        '# Ship brief', '{"harness":"codex","effort":"high"}'::jsonb,
        transaction_timestamp()
      )
    `);

    await expect(
      database.exec(`
        UPDATE agentos.task_assignments
           SET status = 'completed',
               status_text = 'Claimed complete without a report',
               ended_at = transaction_timestamp()
         WHERE id = '${ids.shipAssignment}'
      `),
    ).rejects.toThrow("ending a Task Assignment requires a durable report");
  });

  test("hands off one stable Task with append-only Assignment history", async () => {
    const handoff = await database.query<{ id: string }>(`
      SELECT agentos.handoff_task_assignment(
        '${ids.shipAssignment}',
        '${ids.destination}',
        '# Replacement brief',
        'The original worker preserved its current findings.',
        'Transferred after an explicit handoff',
        '{"harness":"codex","effort":"medium"}'::jsonb
      )::text AS id
    `);
    const replacementId = handoff.rows[0]!.id;

    const repeated = await database.query<{ id: string }>(`
      SELECT agentos.handoff_task_assignment(
        '${ids.shipAssignment}',
        '${ids.destination}',
        '# Replacement brief',
        'The original worker preserved its current findings.',
        'Transferred after an explicit handoff',
        '{"harness":"codex","effort":"medium"}'::jsonb
      )::text AS id
    `);
    expect(repeated.rows[0]!.id).toBe(replacementId);

    const assignments = await database.query<{
      agent_id: string;
      ended: boolean;
      report: string | null;
      supersedes_assignment_id: string | null;
      task_id: string;
    }>(`
      SELECT agent_id::text,
             ended_at IS NOT NULL AS ended,
             report,
             supersedes_assignment_id::text,
             task_id::text
        FROM agentos.task_assignments
       WHERE task_id = '${ids.shipTask}'
       ORDER BY (supersedes_assignment_id IS NOT NULL), created_at, id
    `);

    expect(assignments.rows).toEqual([
      {
        agent_id: ids.scout,
        ended: true,
        report: "The original worker preserved its current findings.",
        supersedes_assignment_id: null,
        task_id: ids.shipTask,
      },
      {
        agent_id: ids.destination,
        ended: false,
        report: null,
        supersedes_assignment_id: ids.shipAssignment,
        task_id: ids.shipTask,
      },
    ]);
  });

  test("keeps Captain decisions open after Scout completion and releases dependent work atomically", async () => {
    await database.exec(`
      INSERT INTO agentos.tasks (
        id, project_id, created_by_agent_id, title, status, status_text
      ) VALUES (
        '${ids.scoutTask}', '${ids.project}', '${ids.firstMate}',
        'Investigate a product choice', 'active', 'Scout ready'
      );
      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, brief, dispatch_profile, started_at
      ) VALUES (
        '${ids.scoutAssignment}', '${ids.scoutTask}', '${ids.scout}',
        '${ids.firstMate}', 'scout', 'active', 'Investigation started',
        '# Scout brief', '{"harness":"codex","effort":"high"}'::jsonb,
        transaction_timestamp()
      )
    `);

    const decision = await database.query<{ id: string }>(`
      SELECT agentos.hold_captain_decision(
        '${ids.scoutTask}',
        'product.default-topology',
        'Choose the default topology',
        'Should the default use the existing cluster or an isolated vCluster?',
        'Awaiting the Captain choice'
      )::text AS id
    `);
    const decisionId = decision.rows[0]!.id;

    await database.exec(`
      SELECT agentos.link_task_decision(
        '${ids.shipTask}',
        'product.default-topology',
        'Blocked on the default topology decision'
      );
      SELECT agentos.attest_assignment_decisions(
        '${ids.scoutAssignment}',
        ARRAY['product.default-topology']::text[]
      );
      UPDATE agentos.task_assignments
         SET status = 'completed',
             status_text = 'Investigation reported with one open Captain choice',
             report = 'Evidence and options are complete.',
             ended_at = transaction_timestamp()
       WHERE id = '${ids.scoutAssignment}';
    `);

    const stillOpen = await database.query<{ count: number }>(`
      SELECT count(*)::int AS count
        FROM agentos.inbox
       WHERE id = '${decisionId}' AND resolved_at IS NULL
    `);
    expect(stillOpen.rows[0]!.count).toBe(1);

    const answer = await database.query<{ id: string }>(`
      SELECT agentos.resolve_captain_decision(
        '${decisionId}',
        'Use an isolated vCluster when sharing an existing production cluster.',
        'Captain selected the isolated path'
      )::text AS id
    `);

    const resolved = await database.query<{
      answer: string;
      decision_resolved: boolean;
      dependencies: unknown[];
    }>(`
      SELECT answer.body AS answer,
             decision.resolved_at IS NOT NULL AS decision_resolved,
             task.dependencies
        FROM agentos.inbox AS decision
        JOIN agentos.inbox AS answer ON answer.id = '${answer.rows[0]!.id}'
        JOIN agentos.tasks AS task ON task.id = '${ids.shipTask}'
       WHERE decision.id = '${decisionId}'
    `);
    expect(resolved.rows).toEqual([
      {
        answer: "Use an isolated vCluster when sharing an existing production cluster.",
        decision_resolved: true,
        dependencies: [],
      },
    ]);
  });

  test("requires an explicit empty decision attestation for a review with no choices", async () => {
    await database.exec(`
      INSERT INTO agentos.tasks (
        id, project_id, created_by_agent_id, title, status, status_text
      ) VALUES (
        '${ids.reviewTask}', '${ids.project}', '${ids.firstMate}',
        'Review a bounded result', 'active', 'Review ready'
      );
      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, brief, dispatch_profile, started_at
      ) VALUES (
        '${ids.reviewAssignment}', '${ids.reviewTask}', '${ids.destination}',
        '${ids.firstMate}', 'review', 'active', 'Review started',
        '# Review brief', '{"harness":"codex","effort":"medium"}'::jsonb,
        transaction_timestamp()
      )
    `);

    await expect(
      database.exec(`
        UPDATE agentos.task_assignments
           SET status = 'completed',
               status_text = 'Review complete',
               report = 'No unresolved Captain choices remain.',
               ended_at = transaction_timestamp()
         WHERE id = '${ids.reviewAssignment}'
      `),
    ).rejects.toThrow("exact Captain-decision attestation");

    await database.exec(`
      SELECT agentos.attest_assignment_decisions(
        '${ids.reviewAssignment}', ARRAY[]::text[]
      );
      UPDATE agentos.task_assignments
         SET status = 'completed',
             status_text = 'Review complete',
             report = 'No unresolved Captain choices remain.',
             ended_at = transaction_timestamp()
       WHERE id = '${ids.reviewAssignment}'
    `);

    const attested = await database.query<{ decision_keys: string[] }>(`
      SELECT decision_keys
        FROM agentos.task_assignments
       WHERE id = '${ids.reviewAssignment}'
    `);
    expect(attested.rows[0]!.decision_keys).toEqual([]);
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
