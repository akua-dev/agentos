import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);

const ids = {
  assignmentA: "55000000-0000-4000-8000-000000000001",
  assignmentB: "55000000-0000-4000-8000-000000000002",
  crewA: "25000000-0000-4000-8000-000000000003",
  crewB: "25000000-0000-4000-8000-000000000005",
  firstMate: "",
  operationA: "75000000-0000-4000-8000-000000000001",
  operationB: "75000000-0000-4000-8000-000000000002",
  operationC: "75000000-0000-4000-8000-000000000003",
  operationD: "75000000-0000-4000-8000-000000000004",
  project: "35000000-0000-4000-8000-000000000001",
  secondA: "25000000-0000-4000-8000-000000000002",
  secondB: "25000000-0000-4000-8000-000000000004",
  taskA: "45000000-0000-4000-8000-000000000001",
  taskB: "45000000-0000-4000-8000-000000000002",
};

const digests = {
  initial: "a".repeat(64),
  replacement: "b".repeat(64),
  teardown: "c".repeat(64),
};

const retainedA = JSON.stringify([
  {
    disposition: "retain",
    kind: "persistent_volume_claim",
    name: "data-runtime-crew-a-0",
  },
  {
    disposition: "retain",
    kind: "worktree",
    name: "runtime-crew-a-task",
  },
]);
const retainedB = JSON.stringify([
  {
    disposition: "retain",
    kind: "persistent_volume_claim",
    name: "data-runtime-crew-b-0",
  },
]);

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
    CREATE ROLE journal_second_a LOGIN;
    CREATE ROLE journal_crew_a LOGIN;
    CREATE ROLE journal_second_b LOGIN;
    CREATE ROLE journal_crew_b LOGIN;

    INSERT INTO agentos.projects (
      id, name, scope_text, status, status_text
    ) VALUES (
      '${ids.project}', 'runtime-operation-journal',
      'Exercise resumable Agent runtime operations',
      'active', 'Runtime journal fixture ready'
    );

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status,
      status_text, persistent_volume_claim
    ) VALUES
      (
        '${ids.secondA}', 'journal-second-a', 'second_mate',
        '${ids.firstMate}', 'pi', 'active', 'Second Mate A ready', NULL
      ),
      (
        '${ids.crewA}', 'journal-crew-a', 'crewmate',
        '${ids.secondA}', 'codex', 'active', 'Crewmate A ready',
        'data-runtime-crew-a-0'
      ),
      (
        '${ids.secondB}', 'journal-second-b', 'second_mate',
        '${ids.firstMate}', 'pi', 'active', 'Second Mate B ready', NULL
      ),
      (
        '${ids.crewB}', 'journal-crew-b', 'crewmate',
        '${ids.secondB}', 'codex', 'active', 'Crewmate B ready',
        'data-runtime-crew-b-0'
      );

    SELECT agentos.register_agent_principal(
      '${ids.secondA}', 'journal_second_a'
    );
    SELECT agentos.register_agent_principal('${ids.crewA}', 'journal_crew_a');
    SELECT agentos.register_agent_principal(
      '${ids.secondB}', 'journal_second_b'
    );
    SELECT agentos.register_agent_principal('${ids.crewB}', 'journal_crew_b');

    INSERT INTO agentos.tasks (
      id, project_id, created_by_agent_id, title, status, status_text
    ) VALUES
      (
        '${ids.taskA}', '${ids.project}', '${ids.secondA}',
        'Recover Crew A runtime', 'active', 'Crew A owns active work'
      ),
      (
        '${ids.taskB}', '${ids.project}', '${ids.secondB}',
        'Finish Crew B before teardown', 'active', 'Crew B owns active work'
      );

    INSERT INTO agentos.task_assignments (
      id, task_id, agent_id, assigned_by_agent_id, assignment_role,
      status, status_text, brief
    ) VALUES
      (
        '${ids.assignmentA}', '${ids.taskA}', '${ids.crewA}', '${ids.secondA}',
        'worker', 'assigned', 'Crew A runtime must recover',
        '# Recover the same Crew A runtime'
      ),
      (
        '${ids.assignmentB}', '${ids.taskB}', '${ids.crewB}', '${ids.secondB}',
        'worker', 'assigned', 'Crew B work is still active',
        '# Complete Crew B work before teardown'
      );
  `);
});

afterAll(async () => {
  await database.close();
});

describe.serial("SQL-backed runtime operation journal", () => {
  test("begins one exact hierarchy-owned operation and fails closed on conflicts", async () => {
    const concurrentBegins = await asRole("journal_second_a", () =>
      Promise.all(
        [0, 1].map(() =>
          database.query<{ id: string }>(`
            SELECT agentos.begin_runtime_operation(
              '${ids.operationA}', '${ids.crewA}', '${ids.assignmentA}',
              'agentos-domain-a', 'runtime-crew-a', 'recover',
              '${digests.initial}', '${retainedA}'::jsonb
            )::text AS id
          `),
        ),
      ),
    );
    expect(concurrentBegins.map(({ rows }) => rows)).toEqual([
      [{ id: ids.operationA }],
      [{ id: ids.operationA }],
    ]);

    const repeated = await asRole("journal_second_a", () =>
      database.query<{ id: string }>(`
        SELECT agentos.begin_runtime_operation(
          '${ids.operationA}', '${ids.crewA}', '${ids.assignmentA}',
          'agentos-domain-a', 'runtime-crew-a', 'recover',
          '${digests.initial}', '${retainedA}'::jsonb
        )::text AS id
      `),
    );
    expect(repeated.rows).toEqual([{ id: ids.operationA }]);

    await asRole("journal_second_a", async () => {
      await expect(
        database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationA}', '${ids.crewA}', '${ids.assignmentA}',
            'agentos-domain-a', 'runtime-crew-a', 'recover',
            '${digests.replacement}', '${retainedA}'::jsonb
          )
        `),
      ).rejects.toThrow("conflicts with the existing runtime operation");

      await expect(
        database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationB}', '${ids.crewA}', '${ids.assignmentA}',
            'agentos-domain-a', 'runtime-crew-a', 'recover',
            '${digests.initial}', '${retainedA}'::jsonb
          )
        `),
      ).rejects.toThrow("already has an active runtime operation");

      await expect(
        database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationB}', '${ids.crewA}', '${ids.assignmentA}',
            'agentos-domain-a', 'runtime-crew-a', 'recover',
            '${digests.initial}',
            '[{"kind":"worktree","name":"crew-a","disposition":"retain","manifest":"forbidden"}]'::jsonb
          )
        `),
      ).rejects.toThrow("retained resources");

      await expect(
        database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationB}', '${ids.crewA}', '${ids.assignmentA}',
            'agentos-domain-a', 'runtime-crew-a', 'recover',
            '${digests.initial}', NULL
          )
        `),
      ).rejects.toThrow("retained resources");
    });

    await asRole("postgres", async () => {
      await expect(
        database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationA}', '${ids.crewA}', '${ids.assignmentA}',
            'agentos-domain-a', 'runtime-crew-a', 'recover',
            '${digests.initial}', '${retainedA}'::jsonb
          )
        `),
      ).rejects.toThrow("conflicts with the existing runtime operation");
    });

    await asRole("journal_second_b", async () => {
      await expect(
        database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationB}', '${ids.crewA}', '${ids.assignmentA}',
            'agentos-domain-a', 'runtime-crew-a', 'recover',
            '${digests.initial}', '${retainedA}'::jsonb
          )
        `),
      ).rejects.toThrow("managed hierarchy");
    });

    await asRole("journal_crew_a", async () => {
      await expect(
        database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationB}', '${ids.crewA}', '${ids.assignmentA}',
            'agentos-domain-a', 'runtime-crew-a', 'recover',
            '${digests.initial}', '${retainedA}'::jsonb
          )
        `),
      ).rejects.toThrow();

      await expect(
        database.exec(`
          INSERT INTO agentos.runtime_operations (
            id, agent_id, owner_agent_id, assignment_id,
            kubernetes_namespace, workload_name, action, render_digest,
            retained_resources, phase
          ) VALUES (
            '${ids.operationB}', '${ids.crewA}', '${ids.secondA}',
            '${ids.assignmentA}', 'agentos-domain-a', 'runtime-crew-a',
            'recover', '${digests.initial}', '${retainedA}'::jsonb, 'prepared'
          )
        `),
      ).rejects.toThrow();
    });

    const visible = await asRole("journal_crew_b", () =>
      database.query<{ id: string; owner_agent_id: string; phase: string }>(`
        SELECT id::text, owner_agent_id::text, phase
          FROM agentos.runtime_operations
         WHERE id = '${ids.operationA}'
      `),
    );
    expect(visible.rows).toEqual([
      {
        id: ids.operationA,
        owner_agent_id: ids.secondA,
        phase: "prepared",
      },
    ]);
  });

  test("records every external boundary, repair-forward recovery, and immutable completion", async () => {
    const transitions: Array<[string, string | null]> = [
      ["recovery_required", "prepare_interrupted"],
      ["prepared", null],
      ["applied", null],
      ["recovery_required", "apply_interrupted"],
      ["applied", null],
      ["workload_ready", null],
      ["recovery_required", "workload_wait_interrupted"],
      ["workload_ready", null],
      ["harness_ready", null],
      ["recovery_required", "harness_confirmation_interrupted"],
      ["harness_ready", null],
    ];

    await asRole("journal_second_a", async () => {
      for (const [phase, decision] of transitions) {
        const observed = await database.query<{ phase: string }>(`
          SELECT agentos.observe_runtime_operation(
            '${ids.operationA}', '${phase}',
            ${decision === null ? "NULL" : `'${decision}'`}
          ) AS phase
        `);
        expect(observed.rows).toEqual([{ phase }]);
      }

      const completed = await database.query<{ phase: string }>(`
        SELECT agentos.complete_runtime_operation('${ids.operationA}') AS phase
      `);
      expect(completed.rows).toEqual([{ phase: "completed" }]);

      const repeated = await database.query<{ phase: string }>(`
        SELECT agentos.complete_runtime_operation('${ids.operationA}') AS phase
      `);
      expect(repeated.rows).toEqual([{ phase: "completed" }]);

      await expect(
        database.query(`
          SELECT agentos.observe_runtime_operation(
            '${ids.operationA}', 'harness_ready', NULL
          )
        `),
      ).rejects.toThrow("completed runtime operation is immutable");

      await expect(
        database.exec(`
          UPDATE agentos.runtime_operations
             SET phase = 'failed'
           WHERE id = '${ids.operationA}'
        `),
      ).rejects.toThrow();
    });

    await asRole("postgres", async () => {
      await expect(
        database.exec(`
          UPDATE agentos.runtime_operations
             SET decision_code = 'owner_rewrite'
           WHERE id = '${ids.operationA}'
        `),
      ).rejects.toThrow("completed runtime operation is immutable");
    });

    const events = await database.query<{
      decision_code: string | null;
      phase: string;
      sequence: number;
    }>(`
      SELECT sequence, phase, decision_code
        FROM agentos.runtime_operation_events
       WHERE operation_id = '${ids.operationA}'
       ORDER BY sequence
    `);
    expect(events.rows.map(({ phase }) => phase)).toEqual([
      "prepared",
      ...transitions.map(([phase]) => phase),
      "completed",
    ]);
    expect(events.rows.at(-1)).toEqual({
      decision_code: null,
      phase: "completed",
      sequence: transitions.length + 2,
    });
  });

  test("supersedes atomically without replacing durable Agent or work identity", async () => {
    const countsBefore = await durableIdentityCounts();

    await asRole("journal_second_a", async () => {
      await database.query(`
        SELECT agentos.begin_runtime_operation(
          '${ids.operationB}', '${ids.crewA}', '${ids.assignmentA}',
          'agentos-domain-a', 'runtime-crew-a', 'rollout',
          '${digests.initial}', '${retainedA}'::jsonb
        )
      `);
      await database.query(`
        SELECT agentos.fail_runtime_operation(
          '${ids.operationB}', 'desired_render_changed'
        )
      `);

      const replacement = await database.query<{ id: string }>(`
        SELECT agentos.supersede_runtime_operation(
          '${ids.operationB}', '${ids.operationC}',
          '${digests.replacement}', '${retainedA}'::jsonb,
          'replace_desired_render'
        )::text AS id
      `);
      expect(replacement.rows).toEqual([{ id: ids.operationC }]);

      const repeated = await database.query<{ id: string }>(`
        SELECT agentos.supersede_runtime_operation(
          '${ids.operationB}', '${ids.operationC}',
          '${digests.replacement}', '${retainedA}'::jsonb,
          'replace_desired_render'
        )::text AS id
      `);
      expect(repeated.rows).toEqual([{ id: ids.operationC }]);

      await expect(
        database.query(`
          SELECT agentos.supersede_runtime_operation(
            '${ids.operationB}', '${ids.operationC}',
            '${digests.initial}', '${retainedA}'::jsonb,
            'replace_desired_render'
          )
        `),
      ).rejects.toThrow("conflicts with the replacement runtime operation");

      const failed = await database.query<{ phase: string }>(`
        SELECT agentos.fail_runtime_operation(
          '${ids.operationC}', 'replacement_admission_rejected'
        ) AS phase
      `);
      expect(failed.rows).toEqual([{ phase: "failed" }]);

      const failedRetry = await database.query<{ phase: string }>(`
        SELECT agentos.fail_runtime_operation(
          '${ids.operationC}', 'replacement_admission_rejected'
        ) AS phase
      `);
      expect(failedRetry.rows).toEqual([{ phase: "failed" }]);
    });

    const operations = await database.query<{
      id: string;
      phase: string;
      supersedes_operation_id: string | null;
    }>(`
      SELECT id::text, phase, supersedes_operation_id::text
        FROM agentos.runtime_operations
       WHERE id IN ('${ids.operationB}', '${ids.operationC}')
       ORDER BY id
    `);
    expect(operations.rows).toEqual([
      {
        id: ids.operationB,
        phase: "superseded",
        supersedes_operation_id: null,
      },
      {
        id: ids.operationC,
        phase: "failed",
        supersedes_operation_id: ids.operationB,
      },
    ]);
    expect(await durableIdentityCounts()).toEqual(countsBefore);
  });

  test("requires ended work and explicit retained-PVC disposition before teardown", async () => {
    await asRole("journal_second_b", async () => {
      await expect(
        database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationD}', '${ids.crewB}', '${ids.assignmentB}',
            'agentos-domain-b', 'runtime-crew-b', 'teardown',
            '${digests.teardown}', '${retainedB}'::jsonb
          )
        `),
      ).rejects.toThrow("teardown requires ended work");
    });

    await database.exec(`
      UPDATE agentos.task_assignments
         SET status = 'completed',
             status_text = 'Crew B work ended before teardown',
             report = '# Crew B final report',
             started_at = transaction_timestamp(),
             ended_at = transaction_timestamp()
       WHERE id = '${ids.assignmentB}'
    `);

    await asRole("journal_second_b", async () => {
      await expect(
        database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationD}', '${ids.crewB}', '${ids.assignmentB}',
            'agentos-domain-b', 'runtime-crew-b', 'teardown',
            '${digests.teardown}', '[]'::jsonb
          )
        `),
      ).rejects.toThrow("explicit retained PVC disposition");

      const begun = await database.query<{ id: string }>(`
        SELECT agentos.begin_runtime_operation(
          '${ids.operationD}', '${ids.crewB}', '${ids.assignmentB}',
          'agentos-domain-b', 'runtime-crew-b', 'teardown',
          '${digests.teardown}', '${retainedB}'::jsonb
        )::text AS id
      `);
      expect(begun.rows).toEqual([{ id: ids.operationD }]);

      await database.query(`
        SELECT agentos.observe_runtime_operation(
          '${ids.operationD}', 'applied', NULL
        )
      `);
      const completed = await database.query<{ phase: string }>(`
        SELECT agentos.complete_runtime_operation('${ids.operationD}') AS phase
      `);
      expect(completed.rows).toEqual([{ phase: "completed" }]);
    });

    const identities = await durableIdentityCounts();
    expect(identities).toEqual({ agents: 5, assignments: 2, tasks: 2 });
    const retainedAgent = await database.query<{
      persistent_volume_claim: string;
    }>(`
      SELECT persistent_volume_claim
        FROM agentos.agents
       WHERE id = '${ids.crewB}'
    `);
    expect(retainedAgent.rows).toEqual([
      { persistent_volume_claim: "data-runtime-crew-b-0" },
    ]);
  });
});

async function durableIdentityCounts() {
  const counts = await database.query<{
    agents: number;
    assignments: number;
    tasks: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM agentos.agents) AS agents,
      (SELECT count(*)::int FROM agentos.task_assignments) AS assignments,
      (SELECT count(*)::int FROM agentos.tasks) AS tasks
  `);
  return counts.rows[0]!;
}

async function asRole<T>(role: string, operation: () => Promise<T>): Promise<T> {
  await database.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await operation();
  } finally {
    await database.exec("SET SESSION AUTHORIZATION postgres");
  }
}
