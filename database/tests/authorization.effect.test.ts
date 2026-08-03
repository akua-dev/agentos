import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const ids = {
  crewmate: "00000000-0000-4000-8000-000000000003",
  firstMate: "00000000-0000-4000-8000-000000000001",
  secondMate: "00000000-0000-4000-8000-000000000002",
};

const databaseLayer = makePGliteTestLayer({
  migrations: [
    new URL("../migrations/0000_initial_fleet_schema.sql", import.meta.url),
    new URL("../migrations/0001_agent_authorization.sql", import.meta.url),
  ],
  setup: (database) => database.exec(`
    CREATE ROLE test_second_mate LOGIN;
    CREATE ROLE test_crewmate LOGIN;
    CREATE ROLE test_outsider LOGIN;

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES
      ('${ids.firstMate}', 'first', 'first_mate', NULL, 'pi', 'active', 'First Mate ready'),
      ('${ids.secondMate}', 'second', 'second_mate', '${ids.firstMate}', 'pi', 'active', 'Second Mate ready'),
      ('${ids.crewmate}', 'crew', 'crewmate', '${ids.secondMate}', 'codex', 'active', 'Crewmate ready');

    SELECT agentos.register_agent_principal('${ids.firstMate}', 'postgres');
    SELECT agentos.register_agent_principal('${ids.secondMate}', 'test_second_mate');
    SELECT agentos.register_agent_principal('${ids.crewmate}', 'test_crewmate');
  `),
});

layer(databaseLayer)("agent database authorization", (it) => {
  it.effect("keeps unmapped database roles outside the AgentOS schema", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const error = yield* Effect.flip(asLogin(
        "test_outsider",
        database.query("SELECT count(*) FROM agentos.agents"),
      ));
      assert.strictEqual(error.operation, "query");
    }));

  it.effect("gives every active Agent an unfiltered Fleet read view", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* database.exec(`
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
          task.id, '${ids.crewmate}', '${ids.secondMate}', 'worker', 'active',
          'Crewmate owns the verification assignment'
        FROM agentos.tasks AS task
        WHERE task.title = 'Verify Fleet reads';
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

      const expectedCounts: ReadonlyArray<readonly [string, number]> = [
        ["agents", 3],
        ["captain", 1],
        ["external_events", 1],
        ["inbox", 0],
        ["learnings", 1],
        ["projects", 1],
        ["task_assignments", 1],
        ["tasks", 1],
      ];
      yield* asLogin("test_crewmate", Effect.forEach(
        expectedCounts,
        ([table, expectedCount]) => database.query<{ readonly count: number }>(
          `SELECT count(*)::int AS count FROM agentos.${table}`,
        ).pipe(
          Effect.flatMap((rows) => firstRow(rows, `missing ${table} count`)),
          Effect.tap((row) => Effect.sync(() => {
            assert.strictEqual(row.count, expectedCount);
          })),
        ),
        { discard: true },
      ));
    }));

  it.effect("limits Agent updates to their managed hierarchy", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin("test_crewmate", Effect.gen(function*() {
        const visible = yield* database.query<{ readonly count: number }>(
          "SELECT count(*)::int AS count FROM agentos.agents",
        );
        assert.strictEqual(
          (yield* firstRow(visible, "missing Agent count")).count,
          3,
        );
        yield* database.exec(`
          UPDATE agentos.agents
             SET status_text = 'Crewmate updated itself'
           WHERE id = '${ids.crewmate}'
        `);
        yield* database.exec(`
          UPDATE agentos.agents
             SET status_text = 'Crewmate tried to update its parent'
           WHERE id = '${ids.secondMate}'
        `);
        const denied = yield* Effect.flip(database.exec(`
          UPDATE agentos.agents
             SET role = 'second_mate'
           WHERE id = '${ids.crewmate}'
        `));
        assert.strictEqual(denied.operation, "exec");
      }));

      yield* asLogin("test_second_mate", Effect.gen(function*() {
        yield* database.exec(`
          UPDATE agentos.agents
             SET status_text = 'Second Mate updated its child'
           WHERE id = '${ids.crewmate}'
        `);
        yield* database.exec(`
          UPDATE agentos.agents
             SET status_text = 'Second Mate tried to update First Mate'
           WHERE id = '${ids.firstMate}'
        `);
      }));

      const statuses = yield* database.query<{
        readonly id: string;
        readonly status_text: string;
      }>(`
        SELECT id, status_text
          FROM agentos.agents
         WHERE id IN ('${ids.firstMate}', '${ids.secondMate}', '${ids.crewmate}')
         ORDER BY id
      `);
      assert.deepStrictEqual(statuses, [
        { id: ids.firstMate, status_text: "First Mate ready" },
        { id: ids.secondMate, status_text: "Second Mate ready" },
        { id: ids.crewmate, status_text: "Second Mate updated its child" },
      ]);
    }));

  it.effect("keeps Inbox fully readable and sender-authentic", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const firstToCrew = "10000000-0000-4000-8000-000000000001";
      const firstToSecond = "10000000-0000-4000-8000-000000000002";
      const crewToFirst = "10000000-0000-4000-8000-000000000003";

      yield* asLogin("postgres", database.exec(`
        INSERT INTO agentos.inbox (
          id, sender_agent_id, sender_label, recipient_agent_id, kind,
          body, decision_key, status, status_text
        ) VALUES
          ('${firstToCrew}', '${ids.firstMate}', 'first', '${ids.crewmate}',
           'request', 'Original request', 'first-to-crew', 'unread', 'Awaiting Crewmate'),
          ('${firstToSecond}', '${ids.firstMate}', 'first', '${ids.secondMate}',
           'private', 'Second Mate only', 'first-to-second', 'unread', 'Awaiting Second Mate')
      `));

      yield* asLogin("test_crewmate", Effect.gen(function*() {
        const visible = yield* database.query<{ readonly decision_key: string }>(`
          SELECT decision_key FROM agentos.inbox ORDER BY decision_key
        `);
        assert.deepStrictEqual(visible, [
          { decision_key: "first-to-crew" },
          { decision_key: "first-to-second" },
        ]);

        const rewrite = yield* Effect.flip(database.exec(`
          UPDATE agentos.inbox
             SET body = 'Recipient rewrote the sender content'
           WHERE id = '${firstToCrew}'
        `));
        assert.strictEqual(rewrite.operation, "exec");
        yield* database.exec(`
          UPDATE agentos.inbox
             SET read_at = transaction_timestamp(),
                 status = 'read',
                 status_text = 'Crewmate read the request'
           WHERE id = '${firstToCrew}'
        `);

        const spoof = yield* Effect.flip(database.exec(`
          INSERT INTO agentos.inbox (
            sender_agent_id, sender_label, recipient_agent_id, kind, body,
            status, status_text
          ) VALUES (
            '${ids.secondMate}', 'second', '${ids.firstMate}', 'spoof',
            'Pretending to be Second Mate', 'unread', 'Spoofed sender'
          )
        `));
        assert.strictEqual(spoof.operation, "exec");

        yield* database.exec(`
          INSERT INTO agentos.inbox (
            id, sender_agent_id, sender_label, recipient_agent_id, kind, body,
            status, status_text
          ) VALUES (
            '${crewToFirst}', '${ids.crewmate}', 'crew', '${ids.firstMate}',
            'reply', 'Initial reply', 'unread', 'Draft reply'
          );
          UPDATE agentos.inbox
             SET body = 'Edited before First Mate read it'
           WHERE id = '${crewToFirst}';
        `);
      }));

      const lateRewrite = yield* Effect.flip(asLogin("postgres", database.exec(`
        UPDATE agentos.inbox
           SET body = 'Sender rewrote content after it was read'
         WHERE id = '${firstToCrew}'
      `)));
      assert.strictEqual(lateRewrite.operation, "exec");

      const secondMateVisible = yield* asLogin(
        "test_second_mate",
        database.query<{ readonly decision_key: string | null }>(`
          SELECT decision_key
            FROM agentos.inbox
           ORDER BY decision_key NULLS LAST
        `),
      );
      assert.deepStrictEqual(secondMateVisible, [
        { decision_key: "first-to-crew" },
        { decision_key: "first-to-second" },
        { decision_key: null },
      ]);
    }));

  it.effect("rejects a login that inherits a PostgreSQL bypass role", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const inheritedAgent = "00000000-0000-4000-8000-000000000004";
      yield* database.exec(`
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
      const error = yield* Effect.flip(database.exec(`
        SELECT agentos.register_agent_principal(
          '${inheritedAgent}', 'test_inherited'
        )
      `));
      assert.include(error.detail, "too privileged");
    }));

  it.effect("requires First Mate to use the Fleet owner role", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const unownedFirstMate = "00000000-0000-4000-8000-000000000005";
      yield* database.exec(`
        CREATE ROLE test_unowned_first_mate LOGIN;
        INSERT INTO agentos.agents (
          id, handle, role, harness, lifecycle_status, status_text
        ) VALUES (
          '${unownedFirstMate}', 'unowned-first', 'first_mate', 'pi', 'active',
          'Awaiting the Fleet owner principal'
        )
      `);
      const error = yield* Effect.flip(database.exec(`
        SELECT agentos.register_agent_principal(
          '${unownedFirstMate}', 'test_unowned_first_mate'
        )
      `));
      assert.include(error.detail, "Fleet owner role");
    }));

  it.effect("removes a retired Agent from the runtime authorization boundary", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* database.exec(`
        UPDATE agentos.agents
           SET retired_at = transaction_timestamp(),
               lifecycle_status = 'retired',
               status_text = 'Retired by Fleet owner'
         WHERE id = '${ids.crewmate}'
      `);

      yield* asLogin("test_crewmate", Effect.forEach([
        "agents",
        "captain",
        "external_events",
        "inbox",
        "learnings",
        "projects",
        "task_assignments",
        "tasks",
      ], (table) => database.query<{ readonly count: number }>(
        `SELECT count(*)::int AS count FROM agentos.${table}`,
      ).pipe(
        Effect.flatMap((rows) => firstRow(rows, `missing ${table} count`)),
        Effect.tap((row) => Effect.sync(() => {
          assert.strictEqual(row.count, 0);
        })),
      ), { discard: true }));
    }));
});
