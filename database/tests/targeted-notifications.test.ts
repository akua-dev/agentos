import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);
const received = new Map<string, string[]>();
const unlisten: (() => Promise<void>)[] = [];

const ids = {
  crewA: "23000000-0000-4000-8000-000000000003",
  crewAssignment: "53000000-0000-4000-8000-000000000001",
  crewTask: "43000000-0000-4000-8000-000000000001",
  firstMate: "",
  inbox: "63000000-0000-4000-8000-000000000001",
  mateAssignment: "53000000-0000-4000-8000-000000000002",
  mateTask: "43000000-0000-4000-8000-000000000002",
  project: "33000000-0000-4000-8000-000000000001",
  secondA: "23000000-0000-4000-8000-000000000002",
  secondB: "23000000-0000-4000-8000-000000000004",
  retiredCrew: "23000000-0000-4000-8000-000000000005",
  provisioningSecond: "23000000-0000-4000-8000-000000000006",
  provisioningCrew: "23000000-0000-4000-8000-000000000007",
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
    CREATE ROLE targeted_second_a LOGIN;
    CREATE ROLE targeted_second_b LOGIN;

    INSERT INTO agentos.projects (
      id, name, scope_text, status, status_text
    ) VALUES (
      '${ids.project}', 'targeted-notifications',
      'Exercise disposable Mate wake routing', 'active', 'Project ready'
    );

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES
      (
        '${ids.secondA}', 'targeted-second-a', 'second_mate',
        '${ids.firstMate}', 'pi', 'active', 'Second Mate A ready'
      ),
      (
        '${ids.crewA}', 'targeted-crew-a', 'crewmate',
        '${ids.secondA}', 'codex', 'active', 'Crewmate A ready'
      ),
      (
        '${ids.secondB}', 'targeted-second-b', 'second_mate',
        '${ids.firstMate}', 'pi', 'active', 'Second Mate B ready'
      );

    SELECT agentos.register_agent_principal(
      '${ids.secondA}', 'targeted_second_a'
    );
    SELECT agentos.register_agent_principal(
      '${ids.secondB}', 'targeted_second_b'
    );

    INSERT INTO agentos.tasks (
      id, project_id, created_by_agent_id, title, status, status_text
    ) VALUES
      (
        '${ids.crewTask}', '${ids.project}', '${ids.secondA}',
        'Crewmate work', 'active', 'Crewmate A owns this'
      ),
      (
        '${ids.mateTask}', '${ids.project}', '${ids.firstMate}',
        'Second Mate work', 'active', 'Second Mate A owns this'
      );

    INSERT INTO agentos.task_assignments (
      id, task_id, agent_id, assigned_by_agent_id, assignment_role,
      status, status_text, brief, dispatch_profile
    ) VALUES
      (
        '${ids.crewAssignment}', '${ids.crewTask}', '${ids.crewA}',
        '${ids.secondA}', 'ship', 'active', 'Crewmate phase active',
        '# Crew brief',
        '{"version":1,"harness":"codex","materials":[],"settings":{}}'::jsonb
      ),
      (
        '${ids.mateAssignment}', '${ids.mateTask}', '${ids.secondA}',
        '${ids.firstMate}', 'coordinate', 'active', 'Mate phase active',
        '# Mate brief',
        '{"version":1,"harness":"pi","materials":[],"settings":{}}'::jsonb
      );
  `);

  for (const channel of [
    "agentos_events",
    expectedChannel(ids.firstMate),
    expectedChannel(ids.secondA),
    expectedChannel(ids.secondB),
  ]) {
    received.set(channel, []);
    unlisten.push(
      await database.listen(channel, (payload) => {
        received.get(channel)!.push(payload);
      }),
    );
  }
});

afterAll(async () => {
  for (const stop of unlisten) await stop();
  await database.close();
});

describe.serial("targeted Mate notifications", () => {
  test("derives one bounded deterministic non-secret channel", async () => {
    const channels = await database.query<{ channel: string }>(`
      SELECT agentos.mate_notification_channel('${ids.firstMate}') AS channel
      UNION ALL
      SELECT agentos.mate_notification_channel('${ids.secondA}')
    `);
    expect(channels.rows.map(({ channel }) => channel)).toEqual([
      expectedChannel(ids.firstMate),
      expectedChannel(ids.secondA),
    ]);
    expect(channels.rows.every(({ channel }) => channel.length === 45)).toBe(
      true,
    );
  });

  test("routes Inbox only to its persistent recipient and never marks it read", async () => {
    clearNotifications();
    await database.exec(`
      INSERT INTO agentos.inbox (
        id, sender_agent_id, sender_label, recipient_agent_id, task_id, kind,
        subject, body, status, status_text
      ) VALUES (
        '${ids.inbox}', '${ids.firstMate}', 'firstmate', '${ids.secondA}',
        '${ids.crewTask}', 'request', 'Review the child outcome',
        'Load the durable request before acting.', 'unread', 'Awaiting receipt'
      )
    `);
    await waitForNotificationCount(1);

    expectTargetSet([ids.secondA]);
    expect(targetPayloads(ids.secondA)).toEqual([
      { operation: "insert", table: "inbox", version: 2 },
    ]);

    const inbox = await database.query<{ read_at: Date | null }>(`
      SELECT read_at FROM agentos.inbox WHERE id = '${ids.inbox}'
    `);
    expect(inbox.rows[0]!.read_at).toBeNull();
  });

  test("does not target the Mate again for its own Inbox receipt", async () => {
    clearNotifications();
    await database.exec(`
      INSERT INTO agentos.inbox (
        id, sender_agent_id, sender_label, recipient_agent_id, task_id, kind,
        subject, body, status, status_text
      ) VALUES (
        '63000000-0000-4000-8000-000000000002',
        '${ids.firstMate}', 'firstmate', '${ids.secondA}', '${ids.crewTask}',
        'notification', 'Receipt-only wake regression',
        'Load this exact durable row.', 'unread', 'Awaiting receipt'
      )
    `);
    await waitForNotificationCount(1);
    clearNotifications();
    await asRole("targeted_second_a", () =>
      database.query(`
        SELECT id
          FROM agentos.receive_inbox(
            '63000000-0000-4000-8000-000000000002'
          )
      `),
    );
    await Bun.sleep(25);

    expectTargetSet([]);
    const inbox = await database.query<{ read_at: Date | null }>(`
      SELECT read_at
        FROM agentos.inbox
       WHERE id = '63000000-0000-4000-8000-000000000002'
    `);
    expect(inbox.rows[0]!.read_at).not.toBeNull();
  });

  test("routes Crewmate work state to its direct supervisor only", async () => {
    clearNotifications();
    await asRole("targeted_second_a", () =>
      database.exec(`
        UPDATE agentos.task_assignments
           SET status = 'blocked',
               status_text = 'Waiting for a reviewed dependency'
         WHERE id = '${ids.crewAssignment}'
      `),
    );
    await waitForNotificationCount(1);

    expectTargetSet([ids.secondA]);
    expect(targetPayloads(ids.secondA)).toEqual([
      { operation: "update", table: "task_assignments", version: 2 },
    ]);
  });

  test("routes hierarchy state to the changed persistent Mate and parent edge", async () => {
    clearNotifications();
    await database.exec(`
      UPDATE agentos.agents
         SET status_text = 'Second Mate A changed durable phase'
       WHERE id = '${ids.secondA}'
    `);
    await waitForNotificationCount(2);

    expectTargetSet([ids.firstMate, ids.secondA]);
  });

  test("routes Fleet and domain Captain state without waking a sibling", async () => {
    clearNotifications();
    await database.exec(`
      INSERT INTO agentos.captain (
        topic, content, recorded_by_agent_id, scope
      ) VALUES (
        'targeted-fleet', 'Fleet policy changed', '${ids.firstMate}', 'fleet'
      )
    `);
    await waitForNotificationCount(1);
    expectTargetSet([ids.firstMate]);

    clearNotifications();
    await asRole("targeted_second_a", () =>
      database.exec(`
        INSERT INTO agentos.captain (
          topic, content, recorded_by_agent_id, scope, scope_agent_id
        ) VALUES (
          'targeted-domain', 'Domain policy changed', '${ids.secondA}',
          'agent', '${ids.secondA}'
        )
      `),
    );
    await waitForNotificationCount(1);
    expectTargetSet([ids.secondA]);
  });

  test("routes unowned external intent to First Mate and claim transition to both owners", async () => {
    clearNotifications();
    await database.exec(`
      INSERT INTO agentos.external_events (
        provider, delivery_id, event_type, coalesce_key, payload,
        batch_started_at, ready_at
      ) VALUES (
        'github', 'targeted-delivery', 'issues', 'repo:targeted', '{}'::jsonb,
        transaction_timestamp() - interval '2 minutes',
        transaction_timestamp() - interval '1 minute'
      )
    `);
    await waitForNotificationCount(1);
    expectTargetSet([ids.firstMate]);

    clearNotifications();
    await asRole("targeted_second_a", () =>
      database.query(`
        SELECT *
          FROM agentos.claim_external_events(
            '${ids.secondA}', 'github', 'repo:targeted', interval '5 minutes'
          )
      `),
    );
    await waitForNotificationCount(2);
    expectTargetSet([ids.firstMate, ids.secondA]);
  });

  test("defers Task routing until atomic acceptance exposes the accountable owner", async () => {
    clearNotifications();
    await database.query(`
      SELECT *
        FROM agentos.create_task_with_assignment(
          '43000000-0000-4000-8000-000000000010',
          '53000000-0000-4000-8000-000000000010',
          '${ids.secondA}',
          '${ids.project}',
          NULL,
          'Atomic Mate outcome',
          'Route from final accepted ownership.',
          'active',
          'Accepted by First Mate for Second Mate A',
          'high',
          '[]'::jsonb,
          '[]'::jsonb,
          '{}'::jsonb,
          'coordinate',
          'assigned',
          'Second Mate A owns the outcome',
          '# Atomic routing brief',
          '{"version":1,"harness":"pi","materials":[],"settings":{}}'::jsonb,
          '{}'::jsonb
        )
    `);
    await waitForNotificationCount(2);

    expectTargetSet([ids.secondA]);
    expect(targetPayloads(ids.secondA)).toEqual([
      { operation: "insert", table: "task_assignments", version: 2 },
      { operation: "insert", table: "tasks", version: 2 },
    ]);
  });

  test("falls back to the active First Mate for retired routing", async () => {
    clearNotifications();
    await database.exec(`
      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status,
        status_text, retired_at
      ) VALUES (
        '${ids.retiredCrew}', 'retired-routing-crew', 'crewmate',
        '${ids.secondB}', 'codex', 'retired', 'Retired routing child',
        transaction_timestamp()
      )
    `);
    clearNotifications();
    await database.exec(`
      UPDATE agentos.agents
         SET retired_at = transaction_timestamp(),
             lifecycle_status = 'retired',
             status_text = 'Retired for notification routing test'
       WHERE id = '${ids.secondB}'
    `);
    await waitForNotificationCount(1);
    expectTargetSet([ids.firstMate]);

    const targets = await database.query<{
      retired_mate_target: string | null;
      retired_parent_target: string | null;
    }>(`
      SELECT
        agentos.notification_mate_for_agent('${ids.secondB}')::text
          AS retired_mate_target,
        agentos.notification_mate_for_agent('${ids.retiredCrew}')::text
          AS retired_parent_target
    `);
    expect(targets.rows[0]).toEqual({
      retired_mate_target: ids.firstMate,
      retired_parent_target: null,
    });

    const fallbackTargets = await database.query<{
      retired_mate_targets: string[] | null;
      retired_parent_targets: string[] | null;
    }>(`
      SELECT
        (
          SELECT array_agg(target::text ORDER BY target)
            FROM agentos.notification_targets(
              'inbox', 'INSERT', NULL,
              jsonb_build_object('recipient_agent_id', '${ids.secondB}'::uuid)
            ) AS target
        ) AS retired_mate_targets,
        (
          SELECT array_agg(target::text ORDER BY target)
            FROM agentos.notification_targets(
              'inbox', 'INSERT', NULL,
              jsonb_build_object('recipient_agent_id', '${ids.retiredCrew}'::uuid)
            ) AS target
        ) AS retired_parent_targets
    `);
    expect(fallbackTargets.rows[0]).toEqual({
      retired_mate_targets: [ids.firstMate],
      retired_parent_targets: [ids.firstMate],
    });
  });

  test("falls back from unregistered provisioning Mates", async () => {
    clearNotifications();
    await database.exec(`
      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES
        (
          '${ids.provisioningSecond}', 'provisioning-second', 'second_mate',
          '${ids.firstMate}', 'pi', 'provisioning', 'Awaiting principal'
        ),
        (
          '${ids.provisioningCrew}', 'provisioning-crew', 'crewmate',
          '${ids.provisioningSecond}', 'codex', 'provisioning', 'Awaiting runtime'
        )
    `);

    const targets = await database.query<{
      direct_target: string | null;
      parent_target: string | null;
      direct_targets: string[] | null;
      parent_targets: string[] | null;
    }>(`
      SELECT
        agentos.notification_mate_for_agent('${ids.provisioningSecond}')::text
          AS direct_target,
        agentos.notification_mate_for_agent('${ids.provisioningCrew}')::text
          AS parent_target,
        (
          SELECT array_agg(target::text ORDER BY target)
            FROM agentos.notification_targets(
              'inbox', 'INSERT', NULL,
              jsonb_build_object(
                'recipient_agent_id', '${ids.provisioningSecond}'::uuid
              )
            ) AS target
        ) AS direct_targets,
        (
          SELECT array_agg(target::text ORDER BY target)
            FROM agentos.notification_targets(
              'inbox', 'INSERT', NULL,
              jsonb_build_object(
                'recipient_agent_id', '${ids.provisioningCrew}'::uuid
              )
            ) AS target
        ) AS parent_targets
    `);

    expect(targets.rows[0]).toEqual({
      direct_target: ids.firstMate,
      parent_target: null,
      direct_targets: [ids.firstMate],
      parent_targets: [ids.firstMate],
    });
  });

  test("emits no global or targeted wake for rollback", async () => {
    clearNotifications();
    await database.exec(`
      BEGIN;
      UPDATE agentos.agents
         SET status_text = 'This targeted wake must roll back'
       WHERE id = '${ids.secondA}';
      ROLLBACK;
    `);
    await Bun.sleep(25);

    expect(totalNotificationCount()).toBe(0);
  });
});

function expectedChannel(agentId: string) {
  return `agentos_mate_${agentId.replaceAll("-", "").toLowerCase()}`;
}

function clearNotifications() {
  for (const payloads of received.values()) payloads.length = 0;
}

function totalNotificationCount() {
  return [...received.values()].reduce(
    (total, payloads) => total + payloads.length,
    0,
  );
}

async function waitForNotificationCount(expected: number) {
  const deadline = Date.now() + 500;
  while (totalNotificationCount() < expected && Date.now() < deadline) {
    await Bun.sleep(5);
  }
  expect(totalNotificationCount()).toBe(expected);
}

function expectTargetSet(expectedAgentIds: string[]) {
  const actual = [ids.firstMate, ids.secondA, ids.secondB]
    .filter((agentId) => received.get(expectedChannel(agentId))!.length > 0)
    .sort();
  expect(actual).toEqual([...expectedAgentIds].sort());
  expect(received.get("agentos_events")!.length).toBe(0);
}

function targetPayloads(agentId: string) {
  return received
    .get(expectedChannel(agentId))!
    .map((payload) => JSON.parse(payload))
    .sort((left, right) => left.table.localeCompare(right.table));
}

async function asRole<T>(role: string, operation: () => Promise<T>): Promise<T> {
  await database.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await operation();
  } finally {
    await database.exec("SET SESSION AUTHORIZATION postgres");
  }
}
