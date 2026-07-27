import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);

const ids = {
  blockedBacklog: "42000000-0000-4000-8000-000000000007",
  captainDecisionA: "62000000-0000-4000-8000-000000000001",
  captainDecisionB: "62000000-0000-4000-8000-000000000002",
  childAssignment: "52000000-0000-4000-8000-000000000002",
  childTask: "42000000-0000-4000-8000-000000000002",
  completedActiveAssignment: "52000000-0000-4000-8000-000000000005",
  completedActiveTask: "42000000-0000-4000-8000-000000000005",
  crewA: "22000000-0000-4000-8000-000000000003",
  crewB: "22000000-0000-4000-8000-000000000005",
  dependencyTask: "42000000-0000-4000-8000-000000000004",
  firstMate: "",
  inboxA: "62000000-0000-4000-8000-000000000003",
  inboxB: "62000000-0000-4000-8000-000000000004",
  ownAssignment: "52000000-0000-4000-8000-000000000001",
  ownTask: "42000000-0000-4000-8000-000000000001",
  ownershipGapAssignment: "52000000-0000-4000-8000-000000000004",
  ownershipGapTask: "42000000-0000-4000-8000-000000000006",
  project: "32000000-0000-4000-8000-000000000001",
  readyBacklog: "42000000-0000-4000-8000-000000000008",
  secondA: "22000000-0000-4000-8000-000000000002",
  secondB: "22000000-0000-4000-8000-000000000004",
  siblingAssignment: "52000000-0000-4000-8000-000000000003",
  siblingBacklog: "42000000-0000-4000-8000-000000000009",
  siblingTask: "42000000-0000-4000-8000-000000000003",
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
    CREATE ROLE bearings_second_a LOGIN;
    CREATE ROLE bearings_crew_a LOGIN;
    CREATE ROLE bearings_second_b LOGIN;
    CREATE ROLE bearings_crew_b LOGIN;
    CREATE ROLE bearings_unregistered LOGIN;

    INSERT INTO agentos.projects (
      id, name, scope_text, status, status_text
    ) VALUES (
      '${ids.project}', 'current-mate-bearings',
      'Exercise bounded durable orientation', 'active', 'Project ready'
    );

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES
      (
        '${ids.secondA}', 'bearings-second-a', 'second_mate',
        '${ids.firstMate}', 'pi', 'active', 'Second Mate A ready'
      ),
      (
        '${ids.crewA}', 'bearings-crew-a', 'crewmate',
        '${ids.secondA}', 'codex', 'active', 'Crewmate A ready'
      ),
      (
        '${ids.secondB}', 'bearings-second-b', 'second_mate',
        '${ids.firstMate}', 'pi', 'active', 'Second Mate B ready'
      ),
      (
        '${ids.crewB}', 'bearings-crew-b', 'crewmate',
        '${ids.secondB}', 'codex', 'active', 'Crewmate B ready'
      );

    SELECT agentos.register_agent_principal(
      '${ids.secondA}', 'bearings_second_a'
    );
    SELECT agentos.register_agent_principal(
      '${ids.crewA}', 'bearings_crew_a'
    );
    SELECT agentos.register_agent_principal(
      '${ids.secondB}', 'bearings_second_b'
    );
    SELECT agentos.register_agent_principal(
      '${ids.crewB}', 'bearings_crew_b'
    );

    INSERT INTO agentos.tasks (
      id, project_id, created_by_agent_id, title, status, status_text,
      dependencies, completed_at
    ) VALUES
      (
        '${ids.ownTask}', '${ids.project}', '${ids.secondA}',
        'Second Mate owned work', 'active', 'Mate owns this outcome',
        '[]'::jsonb, NULL
      ),
      (
        '${ids.childTask}', '${ids.project}', '${ids.secondA}',
        'Direct child work', 'active', 'Direct child owns this outcome',
        '[]'::jsonb, NULL
      ),
      (
        '${ids.siblingTask}', '${ids.project}', '${ids.secondB}',
        'Sibling domain work', 'active', 'Sibling child owns this outcome',
        '[]'::jsonb, NULL
      ),
      (
        '${ids.dependencyTask}', '${ids.project}', '${ids.secondA}',
        'Waiting for Captain', 'blocked', 'Captain decision remains unresolved',
        '[{"kind":"captain_decision","decision_key":"bearings-a"}]'::jsonb,
        NULL
      ),
      (
        '${ids.completedActiveTask}', '${ids.project}', '${ids.secondA}',
        'Inconsistent completed Task', 'completed',
        'Task completed while ownership remains active', '[]'::jsonb,
        transaction_timestamp()
      ),
      (
        '${ids.ownershipGapTask}', '${ids.project}', '${ids.secondA}',
        'Accepted work without active owner', 'active',
        'Historical Assignment ended before Task completion', '[]'::jsonb,
        NULL
      ),
      (
        '${ids.blockedBacklog}', '${ids.project}', '${ids.secondA}',
        'Backlog waiting on decision', 'queued',
        'Queued but dependency is unresolved',
        '[{"kind":"captain_decision","decision_key":"bearings-a"}]'::jsonb,
        NULL
      ),
      (
        '${ids.readyBacklog}', '${ids.project}', '${ids.secondA}',
        'Ready deliberate backlog', 'queued',
        'Ready for explicit acceptance', '[]'::jsonb, NULL
      ),
      (
        '${ids.siblingBacklog}', '${ids.project}', '${ids.secondB}',
        'Sibling deliberate backlog', 'ready',
        'Ready only in the sibling domain', '[]'::jsonb, NULL
      );

    INSERT INTO agentos.task_assignments (
      id, task_id, agent_id, assigned_by_agent_id, assignment_role,
      status, status_text, brief, report, dispatch_profile, ended_at
    ) VALUES
      (
        '${ids.ownAssignment}', '${ids.ownTask}', '${ids.secondA}',
        '${ids.firstMate}', 'coordinate', 'active', 'Mate work active',
        '# Own brief', NULL,
        '{"version":1,"harness":"pi","materials":[],"settings":{}}'::jsonb,
        NULL
      ),
      (
        '${ids.childAssignment}', '${ids.childTask}', '${ids.crewA}',
        '${ids.secondA}', 'ship', 'active', 'Child work active',
        '# Child brief', NULL,
        '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb,
        NULL
      ),
      (
        '${ids.siblingAssignment}', '${ids.siblingTask}', '${ids.crewB}',
        '${ids.secondB}', 'ship', 'active', 'Sibling work active',
        '# Sibling brief', NULL,
        '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb,
        NULL
      ),
      (
        '${ids.ownershipGapAssignment}', '${ids.ownershipGapTask}',
        '${ids.crewA}', '${ids.secondA}', 'ship', 'completed',
        'Historical owner completed', '# Historical brief',
        'The historical owner returned its report.',
        '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb,
        transaction_timestamp()
      ),
      (
        '${ids.completedActiveAssignment}', '${ids.completedActiveTask}',
        '${ids.crewA}', '${ids.secondA}', 'ship', 'active',
        'Ownership still active', '# Completed Task brief', NULL,
        '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb,
        NULL
      );

    INSERT INTO agentos.external_events (
      provider, delivery_id, event_type, coalesce_key, payload,
      batch_started_at, ready_at, reconciliation_status, status_text,
      claimed_by_agent_id, claim_token, claim_expires_at, attempt_count
    ) VALUES
      (
        'github', 'bearings-pending', 'issues', 'repo:pending', '{}'::jsonb,
        transaction_timestamp() - interval '2 minutes',
        transaction_timestamp() - interval '1 minute', 'pending',
        'Ready for reconciliation', NULL, NULL, NULL, 0
      ),
      (
        'github', 'bearings-future', 'issues', 'repo:future', '{}'::jsonb,
        transaction_timestamp(),
        transaction_timestamp() + interval '1 hour', 'pending',
        'Waiting for quiet window', NULL, NULL, NULL, 0
      ),
      (
        'github', 'bearings-own-claim', 'issues', 'repo:own', '{}'::jsonb,
        transaction_timestamp() - interval '2 minutes',
        transaction_timestamp() - interval '1 minute', 'processing',
        'Claimed by Second Mate A', '${ids.secondA}',
        '72000000-0000-4000-8000-000000000001',
        transaction_timestamp() + interval '1 hour', 1
      ),
      (
        'github', 'bearings-expired', 'issues', 'repo:expired', '{}'::jsonb,
        transaction_timestamp() - interval '2 minutes',
        transaction_timestamp() - interval '1 minute', 'processing',
        'Expired sibling claim', '${ids.secondB}',
        '72000000-0000-4000-8000-000000000002',
        transaction_timestamp() - interval '1 minute', 1
      ),
      (
        'github', 'bearings-other-claim', 'issues', 'repo:other', '{}'::jsonb,
        transaction_timestamp() - interval '2 minutes',
        transaction_timestamp() - interval '1 minute', 'processing',
        'Live sibling claim', '${ids.secondB}',
        '72000000-0000-4000-8000-000000000003',
        transaction_timestamp() + interval '1 hour', 1
      );
  `);

  await asRole("bearings_second_a", () =>
    database.exec(`
      INSERT INTO agentos.inbox (
        id, sender_agent_id, sender_label, recipient_agent_id, task_id, kind,
        subject, body, decision_key, status, status_text
      ) VALUES (
        '${ids.captainDecisionA}', '${ids.secondA}', 'bearings-second-a',
        '${ids.secondA}', '${ids.dependencyTask}', 'captain_decision',
        'Choose the delivery boundary', 'Which boundary should apply?',
        'bearings-a', 'awaiting_captain', 'Captain answer required'
      )
    `),
  );

  await asRole("bearings_second_b", () =>
    database.exec(`
      INSERT INTO agentos.inbox (
        id, sender_agent_id, sender_label, recipient_agent_id, task_id, kind,
        subject, body, decision_key, status, status_text
      ) VALUES (
        '${ids.captainDecisionB}', '${ids.secondB}', 'bearings-second-b',
        '${ids.secondB}', '${ids.siblingBacklog}', 'captain_decision',
        'Sibling choice', 'This belongs to the sibling domain.',
        'bearings-b', 'awaiting_captain', 'Sibling answer required'
      )
    `),
  );

  await database.exec(`
    INSERT INTO agentos.inbox (
      id, sender_agent_id, sender_label, recipient_agent_id, task_id, kind,
      subject, body, status, status_text, read_at, resolved_at
    ) VALUES
      (
        '${ids.inboxA}', '${ids.firstMate}', 'firstmate',
        '${ids.secondA}', '${ids.childTask}', 'request',
        'Review child progress', 'Review the durable child state.',
        'open', 'Awaiting Second Mate review', NULL, NULL
      ),
      (
        '${ids.inboxB}', '${ids.firstMate}', 'firstmate',
        '${ids.secondB}', '${ids.siblingTask}', 'request',
        'Review sibling progress', 'Review sibling durable state.',
        'open', 'Awaiting sibling review', NULL, NULL
      ),
      (
        '62000000-0000-4000-8000-000000000005',
        '${ids.firstMate}', 'firstmate', '${ids.secondA}', '${ids.ownTask}',
        'notification', 'Already handled', 'This row is resolved.',
        'resolved', 'Handled already', transaction_timestamp(),
        transaction_timestamp()
      )
  `);
});

afterAll(async () => {
  await database.close();
});

describe.serial("current Mate bearings", () => {
  test("returns typed durable facts for only the Second Mate domain", async () => {
    await asRole("bearings_second_a", async () => {
      const bearings = await readBearings();
      const byKind = Object.groupBy(
        bearings.rows,
        (row) => row.bearing_kind,
      );

      expect(byKind.unresolved_inbox?.map((row) => row.inbox_id)).toEqual([
        ids.inboxA,
      ]);
      expect(byKind.captain_decision?.map((row) => row.inbox_id)).toEqual([
        ids.captainDecisionA,
      ]);
      expect(
        byKind.own_active_assignment?.map((row) => row.assignment_id),
      ).toEqual([ids.ownAssignment]);
      expect(
        byKind.direct_child_active_assignment?.map(
          (row) => row.assignment_id,
        ),
      ).toEqual([ids.childAssignment, ids.completedActiveAssignment]);
      expect(
        byKind.managed_task_reconciliation?.map((row) => row.task_id),
      ).toEqual([
        ids.dependencyTask,
        ids.completedActiveTask,
        ids.ownershipGapTask,
        ids.blockedBacklog,
      ]);
      expect(
        byKind.queued_ready_backlog?.map((row) => row.task_id),
      ).toEqual([ids.readyBacklog]);

      const externalStatuses = byKind.external_event?.map((row) => row.status);
      expect(externalStatuses).toEqual([
        "pending",
        "processing",
        "processing",
      ]);

      const serialized = JSON.stringify(bearings.rows);
      expect(serialized).not.toContain(ids.siblingAssignment);
      expect(serialized).not.toContain(ids.siblingBacklog);
      expect(serialized).not.toContain(ids.captainDecisionB);
      expect(serialized).not.toContain(ids.inboxB);
      expect(serialized).not.toContain("Which boundary should apply?");
      expect(serialized).not.toContain("repo:pending");
    });
  });

  test("separates categories and exposes deterministic dependency facts", async () => {
    await asRole("bearings_second_a", async () => {
      const bearings = await readBearings();
      const decision = bearings.rows.find(
        (row) => row.inbox_id === ids.captainDecisionA,
      );
      expect(decision?.bearing_kind).toBe("captain_decision");

      const dependency = bearings.rows.find(
        (row) =>
          row.bearing_kind === "managed_task_reconciliation" &&
          row.task_id === ids.dependencyTask,
      );
      expect(dependency).toMatchObject({
        assignment_id: null,
        dependencies_satisfied: false,
        dependency_count: 1,
        inbox_id: null,
        unresolved_decision_count: 1,
      });

      const ready = bearings.rows.find(
        (row) =>
          row.bearing_kind === "queued_ready_backlog" &&
          row.task_id === ids.readyBacklog,
      );
      expect(ready).toMatchObject({
        assignment_id: null,
        dependencies_satisfied: true,
        dependency_count: 0,
        inbox_id: null,
        unresolved_decision_count: 0,
      });

      expect(
        bearings.rows.some(
          (row) =>
            row.task_id === ids.readyBacklog &&
            row.bearing_kind.includes("assignment"),
        ),
      ).toBe(false);
    });
  });

  test("is repeatable and does not acknowledge, claim, or revise durable rows", async () => {
    const before = await durableState();

    await asRole("bearings_second_a", async () => {
      const first = await readBearings();
      const second = await readBearings();
      expect(second.rows).toEqual(first.rows);
    });

    const after = await durableState();
    expect(after.rows).toEqual(before.rows);
  });

  test("keeps execution to authenticated Mates", async () => {
    const fleet = await readBearings();
    expect(
      fleet.rows.some((row) => row.task_id === ids.siblingBacklog),
    ).toBe(true);

    await asRole("bearings_crew_a", async () => {
      await expect(readBearings()).rejects.toThrow();
    });

    await asRole("bearings_unregistered", async () => {
      await expect(readBearings()).rejects.toThrow();
    });
  });
});

type Bearing = {
  agent_id: string | null;
  assignment_id: string | null;
  bearing_kind: string;
  claim_expires_at: Date | null;
  created_at: Date;
  dependencies_satisfied: boolean | null;
  dependency_count: number | null;
  external_event_id: number | null;
  inbox_id: string | null;
  item_kind: string;
  project_id: string | null;
  read_at: Date | null;
  ready_at: Date | null;
  status: string;
  status_text: string;
  subject: string | null;
  task_id: string | null;
  unresolved_decision_count: number | null;
  updated_at: Date;
};

function readBearings() {
  return database.query<Bearing>(`
    SELECT
      bearing_kind,
      inbox_id::text,
      task_id::text,
      assignment_id::text,
      agent_id::text,
      project_id::text,
      external_event_id,
      item_kind,
      status,
      status_text,
      subject,
      dependency_count,
      unresolved_decision_count,
      dependencies_satisfied,
      read_at,
      ready_at,
      claim_expires_at,
      created_at,
      updated_at
    FROM agentos.current_mate_bearings()
  `);
}

function durableState() {
  return database.query<{
    key: string;
    state: string;
  }>(`
    SELECT 'inbox:' || id::text AS key,
           jsonb_build_object(
             'read_at', read_at,
             'resolved_at', resolved_at,
             'status', status,
             'updated_at', updated_at
           )::text AS state
      FROM agentos.inbox
     WHERE id IN ('${ids.inboxA}', '${ids.captainDecisionA}')
    UNION ALL
    SELECT 'task:' || id::text,
           jsonb_build_object(
             'revision', revision,
             'status', status,
             'updated_at', updated_at
           )::text
      FROM agentos.tasks
     WHERE id IN ('${ids.dependencyTask}', '${ids.readyBacklog}')
    UNION ALL
    SELECT 'assignment:' || id::text,
           jsonb_build_object(
             'status', status,
             'started_at', started_at,
             'ended_at', ended_at,
             'updated_at', updated_at
           )::text
      FROM agentos.task_assignments
     WHERE id IN ('${ids.ownAssignment}', '${ids.childAssignment}')
    UNION ALL
    SELECT 'external:' || id::text,
           jsonb_build_object(
             'status', reconciliation_status,
             'claimed_by_agent_id', claimed_by_agent_id,
             'claim_token', claim_token,
             'claim_expires_at', claim_expires_at,
             'updated_at', updated_at
           )::text
      FROM agentos.external_events
    ORDER BY key
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
