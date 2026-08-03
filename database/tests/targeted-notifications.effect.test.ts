import { assert, layer } from "@effect/vitest";
import { Effect, Fiber, Schema, Stream } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const NotificationSchema = Schema.Struct({
  version: Schema.Literal(2),
  table: Schema.String,
  operation: Schema.String,
});
const decodeNotification = Schema.decodeUnknownEffect(
  Schema.fromJsonString(NotificationSchema),
);

interface NotificationProbe {
  readonly agentId: string;
  readonly channel: string;
  readonly expectedCount: number;
  readonly fiber: Fiber.Fiber<ReadonlyArray<string>, unknown>;
}

const ids = {
  crewA: "23000000-0000-4000-8000-000000000003",
  crewAssignment: "53000000-0000-4000-8000-000000000001",
  crewTask: "43000000-0000-4000-8000-000000000001",
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

function expectedChannel(agentId: string) {
  return `agentos_mate_${agentId.replaceAll("-", "").toLowerCase()}`;
}

const firstMateId = Effect.fn("test.targetedNotifications.firstMateId")(
  function*() {
    const database = yield* PGliteTestDatabase;
    const roots = yield* database.query<{ readonly id: string }>(`
      SELECT id::text AS id
        FROM agentos.agents
       WHERE role = 'first_mate'
         AND retired_at IS NULL
    `);
    return (yield* firstRow(roots, "test Fleet has no First Mate")).id;
  },
);

const probeNotifications = Effect.fn("test.targetedNotifications.probe")(
  function*(expectedAgentIds: ReadonlyArray<string>) {
    const database = yield* PGliteTestDatabase;
    const rootId = yield* firstMateId();
    const candidates = [
      { agentId: "global", channel: "agentos_events" },
      { agentId: rootId, channel: expectedChannel(rootId) },
      { agentId: ids.secondA, channel: expectedChannel(ids.secondA) },
      { agentId: ids.secondB, channel: expectedChannel(ids.secondB) },
    ];

    return yield* Effect.forEach(candidates, (candidate) =>
      Effect.gen(function*() {
        const expectedCount = expectedAgentIds.filter(
          (agentId) => agentId === candidate.agentId,
        ).length;
        const notifications = yield* database.listen(candidate.channel);
        const fiber = yield* Effect.forkChild(
          notifications.pipe(
            Stream.take(Math.max(1, expectedCount)),
            Stream.runCollect,
          ),
        );
        return { ...candidate, expectedCount, fiber };
      }));
  },
);

const readNotifications = Effect.fn("test.targetedNotifications.read")(
  function*(probes: ReadonlyArray<NotificationProbe>) {
    const observed = yield* Effect.forEach(
      probes.filter(({ expectedCount }) => expectedCount > 0),
      (probe) => Effect.gen(function*() {
        const payloads = yield* Fiber.join(probe.fiber);
        assert.strictEqual(payloads.length, probe.expectedCount);
        return yield* Effect.forEach(Array.from(payloads), (payload) =>
          decodeNotification(payload).pipe(
            Effect.map((notification) => ({
              agentId: probe.agentId,
              ...notification,
            })),
          ));
      }),
    );

    yield* Effect.yieldNow;
    yield* Effect.forEach(
      probes.filter(({ expectedCount }) => expectedCount === 0),
      (probe) => Effect.sync(() => probe.fiber.pollUnsafe()).pipe(
        Effect.map((exit) => {
          assert.isTrue(
            exit === undefined,
            `unexpected notification on ${probe.channel}`,
          );
        }),
      ),
      { discard: true },
    );

    return observed.flat();
  },
);

function normalizedNotifications(
  notifications: ReadonlyArray<{
    readonly agentId: string;
    readonly operation: string;
    readonly table: string;
    readonly version: 2;
  }>,
) {
  return notifications.toSorted((left, right) =>
    `${left.agentId}:${left.table}:${left.operation}`.localeCompare(
      `${right.agentId}:${right.table}:${right.operation}`,
    ));
}

const databaseLayer = makePGliteTestLayer({
  migrations: "all",
  setup: (database) => Effect.gen(function*() {
    const roots = yield* database.query<{ readonly id: string }>(`
      SELECT id::text AS id
        FROM agentos.agents
       WHERE role = 'first_mate'
    `);
    const firstMate = (yield* firstRow(
      roots,
      "test Fleet has no First Mate",
    )).id;

    yield* database.exec(`
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
          '${firstMate}', 'pi', 'active', 'Second Mate A ready'
        ),
        (
          '${ids.crewA}', 'targeted-crew-a', 'crewmate',
          '${ids.secondA}', 'codex', 'active', 'Crewmate A ready'
        ),
        (
          '${ids.secondB}', 'targeted-second-b', 'second_mate',
          '${firstMate}', 'pi', 'active', 'Second Mate B ready'
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
          '${ids.mateTask}', '${ids.project}', '${firstMate}',
          'Second Mate work', 'active', 'Second Mate A owns this'
        );

      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, brief
      ) VALUES
        (
          '${ids.crewAssignment}', '${ids.crewTask}', '${ids.crewA}',
          '${ids.secondA}', 'ship', 'active', 'Crewmate phase active',
          '# Crew brief'
        ),
        (
          '${ids.mateAssignment}', '${ids.mateTask}', '${ids.secondA}',
          '${firstMate}', 'coordinate', 'active', 'Mate phase active',
          '# Mate brief'
        );
    `);
  }),
});

layer(databaseLayer)("targeted Mate notifications", (it) => {
  it.effect("derives one bounded deterministic non-secret channel", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const rootId = yield* firstMateId();
      const channels = yield* database.query<{ readonly channel: string }>(`
        SELECT agentos.mate_notification_channel('${rootId}') AS channel
        UNION ALL
        SELECT agentos.mate_notification_channel('${ids.secondA}')
      `);
      assert.deepStrictEqual(channels.map(({ channel }) => channel), [
        expectedChannel(rootId),
        expectedChannel(ids.secondA),
      ]);
      assert.isTrue(channels.every(({ channel }) => channel.length === 45));
    }));

  it.effect("routes Inbox only to its persistent recipient and never marks it read", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const probes = yield* probeNotifications([ids.secondA]);
      yield* database.exec(`
        INSERT INTO agentos.inbox (
          id, sender_agent_id, sender_label, recipient_agent_id, task_id, kind,
          subject, body, status, status_text
        ) VALUES (
          '${ids.inbox}', '${yield* firstMateId()}', 'firstmate',
          '${ids.secondA}', '${ids.crewTask}', 'request',
          'Review the child outcome', 'Load the durable request before acting.',
          'unread', 'Awaiting receipt'
        )
      `);

      assert.deepStrictEqual(yield* readNotifications(probes), [{
        agentId: ids.secondA,
        operation: "insert",
        table: "inbox",
        version: 2,
      }]);
      const inbox = yield* database.query<{ readonly read_at: Date | null }>(`
        SELECT read_at FROM agentos.inbox WHERE id = '${ids.inbox}'
      `);
      assert.isNull((yield* firstRow(inbox, "missing Inbox row")).read_at);
    }));

  it.effect("does not target the Mate again for its own Inbox receipt", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const rootId = yield* firstMateId();
      const receiptInbox = "63000000-0000-4000-8000-000000000002";
      yield* database.exec(`
        INSERT INTO agentos.inbox (
          id, sender_agent_id, sender_label, recipient_agent_id, task_id, kind,
          subject, body, status, status_text
        ) VALUES (
          '${receiptInbox}', '${rootId}', 'firstmate', '${ids.secondA}',
          '${ids.crewTask}', 'notification', 'Receipt-only wake regression',
          'Load this exact durable row.', 'unread', 'Awaiting receipt'
        )
      `);

      const probes = yield* probeNotifications([ids.secondA]);
      yield* asLogin(
        "targeted_second_a",
        database.query(`
          SELECT id FROM agentos.receive_inbox('${receiptInbox}')
        `),
      );
      yield* database.exec(`
        UPDATE agentos.task_assignments
           SET status_text = 'Receipt ordering sentinel'
         WHERE id = '${ids.crewAssignment}'
      `);

      assert.deepStrictEqual(yield* readNotifications(probes), [{
        agentId: ids.secondA,
        operation: "update",
        table: "task_assignments",
        version: 2,
      }]);
      const inbox = yield* database.query<{ readonly read_at: Date | null }>(`
        SELECT read_at FROM agentos.inbox WHERE id = '${receiptInbox}'
      `);
      assert.isNotNull((yield* firstRow(inbox, "missing receipt Inbox")).read_at);
    }));

  it.effect("routes Crewmate work state to its direct supervisor only", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const probes = yield* probeNotifications([ids.secondA]);
      yield* asLogin(
        "targeted_second_a",
        database.exec(`
          UPDATE agentos.task_assignments
             SET status = 'blocked',
                 status_text = 'Waiting for a reviewed dependency'
           WHERE id = '${ids.crewAssignment}'
        `),
      );
      assert.deepStrictEqual(yield* readNotifications(probes), [{
        agentId: ids.secondA,
        operation: "update",
        table: "task_assignments",
        version: 2,
      }]);
    }));

  it.effect("routes hierarchy state to the changed persistent Mate and parent edge", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const rootId = yield* firstMateId();
      const probes = yield* probeNotifications([rootId, ids.secondA]);
      yield* database.exec(`
        UPDATE agentos.agents
           SET status_text = 'Second Mate A changed durable phase'
         WHERE id = '${ids.secondA}'
      `);
      assert.deepStrictEqual(
        normalizedNotifications(yield* readNotifications(probes)),
        normalizedNotifications([
          { agentId: rootId, operation: "update", table: "agents", version: 2 },
          { agentId: ids.secondA, operation: "update", table: "agents", version: 2 },
        ]),
      );
    }));

  it.effect("routes Mate guidance through its explicit Inbox recipient only", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const rootId = yield* firstMateId();
      const probes = yield* probeNotifications([rootId]);
      yield* asLogin(
        "targeted_second_a",
        database.exec(`
          INSERT INTO agentos.inbox (
            id, sender_agent_id, sender_label, recipient_agent_id, task_id,
            kind, subject, body, status, status_text
          ) VALUES (
            '63000000-0000-4000-8000-000000000003', '${ids.secondA}',
            'targeted-second-a', '${rootId}', '${ids.mateTask}',
            'notification', 'Guidance learned',
            'Review this durable guidance and propagate it deliberately.',
            'unread', 'Awaiting First Mate receipt'
          )
        `),
      );
      assert.deepStrictEqual(yield* readNotifications(probes), [{
        agentId: rootId,
        operation: "insert",
        table: "inbox",
        version: 2,
      }]);
    }));

  it.effect("routes unowned external intent to First Mate and claim transition to both owners", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const rootId = yield* firstMateId();
      const unowned = yield* probeNotifications([rootId]);
      yield* database.exec(`
        INSERT INTO agentos.external_events (
          provider, delivery_id, event_type, coalesce_key, payload,
          batch_started_at, ready_at
        ) VALUES (
          'github', 'targeted-delivery', 'issues', 'repo:targeted', '{}'::jsonb,
          transaction_timestamp() - interval '2 minutes',
          transaction_timestamp() - interval '1 minute'
        )
      `);
      assert.deepStrictEqual(yield* readNotifications(unowned), [{
        agentId: rootId,
        operation: "insert",
        table: "external_events",
        version: 2,
      }]);

      const claimed = yield* probeNotifications([rootId, ids.secondA]);
      yield* asLogin(
        "targeted_second_a",
        database.query(`
          SELECT * FROM agentos.claim_external_events(
            '${ids.secondA}', 'github', 'repo:targeted', interval '5 minutes'
          )
        `),
      );
      assert.deepStrictEqual(
        normalizedNotifications(yield* readNotifications(claimed)),
        normalizedNotifications([
          {
            agentId: rootId,
            operation: "update",
            table: "external_events",
            version: 2,
          },
          {
            agentId: ids.secondA,
            operation: "update",
            table: "external_events",
            version: 2,
          },
        ]),
      );
    }));

  it.effect("defers Task routing until atomic acceptance exposes the accountable owner", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const probes = yield* probeNotifications([ids.secondA, ids.secondA]);
      yield* database.query(`
        SELECT * FROM agentos.create_task_with_assignment(
          '43000000-0000-4000-8000-000000000010',
          '53000000-0000-4000-8000-000000000010',
          '${ids.secondA}', '${ids.project}', NULL, 'Atomic Mate outcome',
          'Route from final accepted ownership.', 'active',
          'Accepted by First Mate for Second Mate A', 'high',
          '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'coordinate', 'assigned',
          'Second Mate A owns the outcome', '# Atomic routing brief', '{}'::jsonb
        )
      `);
      assert.deepStrictEqual(
        normalizedNotifications(yield* readNotifications(probes)),
        normalizedNotifications([
          {
            agentId: ids.secondA,
            operation: "insert",
            table: "task_assignments",
            version: 2,
          },
          {
            agentId: ids.secondA,
            operation: "insert",
            table: "tasks",
            version: 2,
          },
        ]),
      );
    }));

  it.effect("falls back to the active First Mate for retired routing", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const rootId = yield* firstMateId();
      yield* database.exec(`
        INSERT INTO agentos.agents (
          id, handle, role, parent_agent_id, harness, lifecycle_status,
          status_text, retired_at
        ) VALUES (
          '${ids.retiredCrew}', 'retired-routing-crew', 'crewmate',
          '${ids.secondB}', 'codex', 'retired', 'Retired routing child',
          transaction_timestamp()
        )
      `);

      const probes = yield* probeNotifications([rootId]);
      yield* database.exec(`
        UPDATE agentos.agents
           SET retired_at = transaction_timestamp(),
               lifecycle_status = 'retired',
               status_text = 'Retired for notification routing test'
         WHERE id = '${ids.secondB}'
      `);
      assert.deepStrictEqual(yield* readNotifications(probes), [{
        agentId: rootId,
        operation: "update",
        table: "agents",
        version: 2,
      }]);

      const targets = yield* database.query<{
        readonly retired_mate_target: string | null;
        readonly retired_parent_target: string | null;
      }>(`
        SELECT
          agentos.notification_mate_for_agent('${ids.secondB}')::text
            AS retired_mate_target,
          agentos.notification_mate_for_agent('${ids.retiredCrew}')::text
            AS retired_parent_target
      `);
      assert.deepStrictEqual(yield* firstRow(targets, "missing retired targets"), {
        retired_mate_target: rootId,
        retired_parent_target: null,
      });

      const fallbacks = yield* database.query<{
        readonly retired_mate_targets: ReadonlyArray<string> | null;
        readonly retired_parent_targets: ReadonlyArray<string> | null;
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
      assert.deepStrictEqual(
        yield* firstRow(fallbacks, "missing retired fallbacks"),
        {
          retired_mate_targets: [rootId],
          retired_parent_targets: [rootId],
        },
      );
    }));

  it.effect("falls back from unregistered provisioning Mates", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const rootId = yield* firstMateId();
      yield* database.exec(`
        INSERT INTO agentos.agents (
          id, handle, role, parent_agent_id, harness, lifecycle_status,
          status_text
        ) VALUES
          (
            '${ids.provisioningSecond}', 'provisioning-second', 'second_mate',
            '${rootId}', 'pi', 'provisioning', 'Awaiting principal'
          ),
          (
            '${ids.provisioningCrew}', 'provisioning-crew', 'crewmate',
            '${ids.provisioningSecond}', 'codex', 'provisioning',
            'Awaiting runtime'
          )
      `);

      const targets = yield* database.query<{
        readonly direct_target: string | null;
        readonly parent_target: string | null;
        readonly direct_targets: ReadonlyArray<string> | null;
        readonly parent_targets: ReadonlyArray<string> | null;
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
      assert.deepStrictEqual(yield* firstRow(targets, "missing provision targets"), {
        direct_target: rootId,
        parent_target: null,
        direct_targets: [rootId],
        parent_targets: [rootId],
      });
    }));

  it.effect("emits no global or targeted wake for rollback", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const rootId = yield* firstMateId();
      const probes = yield* probeNotifications([ids.secondA]);
      yield* database.exec(`
        BEGIN;
        UPDATE agentos.agents
           SET status_text = 'This targeted wake must roll back'
         WHERE id = '${ids.secondA}';
        ROLLBACK;

        INSERT INTO agentos.inbox (
          id, sender_agent_id, sender_label, recipient_agent_id, kind,
          subject, body, status, status_text
        ) VALUES (
          '63000000-0000-4000-8000-000000000004', '${rootId}', 'firstmate',
          '${ids.secondA}', 'notification', 'Rollback ordering sentinel',
          'Only this committed wake may be observed.', 'unread',
          'Committed after rollback'
        );
      `);
      assert.deepStrictEqual(yield* readNotifications(probes), [{
        agentId: ids.secondA,
        operation: "insert",
        table: "inbox",
        version: 2,
      }]);

      const durable = yield* database.query<{ readonly status_text: string }>(`
        SELECT status_text FROM agentos.agents WHERE id = '${ids.secondA}'
      `);
      assert.strictEqual(
        (yield* firstRow(durable, "missing Second Mate row")).status_text,
        "Second Mate A changed durable phase",
      );
    }));
});
