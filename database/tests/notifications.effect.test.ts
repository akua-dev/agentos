import { assert, layer } from "@effect/vitest";
import { Effect, Fiber, Option, Schema, Stream } from "effect";

import {
  PGliteTestDatabase,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const NotificationSchema = Schema.Struct({
  version: Schema.Literal(2),
  table: Schema.String,
  operation: Schema.String,
});

function expectedChannel(agentId: string) {
  return `agentos_mate_${agentId.replaceAll("-", "").toLowerCase()}`;
}

const firstMateId = Effect.fn("test.notifications.firstMateId")(function*() {
  const database = yield* PGliteTestDatabase;
  const rows = yield* database.query<{ readonly id: string }>(`
    SELECT id::text AS id
      FROM agentos.agents
     WHERE role = 'first_mate'
       AND retired_at IS NULL
  `);
  return (yield* firstRow(rows, "test Fleet has no First Mate")).id;
});

const nextNotification = Effect.fn("test.notifications.next")(function*() {
  const database = yield* PGliteTestDatabase;
  const agentId = yield* firstMateId();
  const notifications = yield* database.listen(expectedChannel(agentId));
  const fiber = yield* Effect.forkChild(notifications.pipe(Stream.runHead));
  return { agentId, fiber };
});

layer(makePGliteTestLayer({ migrations: "all" }))(
  "Fleet notifications",
  (it) => {
    it.effect("notifies after commit and leaves the durable row authoritative", () =>
      Effect.gen(function*() {
        const database = yield* PGliteTestDatabase;
        const pending = yield* nextNotification();

        yield* database.exec(`
          UPDATE agentos.agents
             SET status_text = 'Notification test committed'
           WHERE id = '${pending.agentId}'
        `);
        const notification = yield* Fiber.join(pending.fiber);
        assert.isTrue(Option.isSome(notification));
        if (Option.isSome(notification)) {
          assert.deepStrictEqual(
            yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(NotificationSchema),
            )(notification.value),
            { version: 2, table: "agents", operation: "update" },
          );
        }

        const durable = yield* database.query<{
          readonly status_text: string;
        }>(`
          SELECT status_text
            FROM agentos.agents
           WHERE id = '${pending.agentId}'
        `);
        assert.strictEqual(
          (yield* firstRow(durable, "missing durable First Mate row")).status_text,
          "Notification test committed",
        );
      }));

    it.effect("emits nothing for rolled-back changes", () =>
      Effect.gen(function*() {
        const database = yield* PGliteTestDatabase;
        const pending = yield* nextNotification();

        yield* database.exec(`
          BEGIN;
          UPDATE agentos.agents
             SET status_text = 'Notification test rolled back'
           WHERE role = 'first_mate';
          ROLLBACK;

          INSERT INTO agentos.tasks (
            created_by_agent_id, title, status, status_text
          ) VALUES (
            '${pending.agentId}', 'Notification ordering sentinel',
            'backlog', 'Committed after rollback'
          );
        `);

        const notification = yield* Fiber.join(pending.fiber);
        assert.isTrue(Option.isSome(notification));
        if (Option.isSome(notification)) {
          assert.deepStrictEqual(
            yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(NotificationSchema),
            )(notification.value),
            { version: 2, table: "tasks", operation: "insert" },
          );
        }

        const durable = yield* database.query<{
          readonly status_text: string;
        }>(`
          SELECT status_text
            FROM agentos.agents
           WHERE id = '${pending.agentId}'
        `);
        assert.strictEqual(
          (yield* firstRow(durable, "missing durable First Mate row")).status_text,
          "Notification test committed",
        );
      }));

    it.effect("covers the actionable coordination tables", () =>
      Effect.gen(function*() {
        const database = yield* PGliteTestDatabase;
        const triggers = yield* database.query<{
          readonly table_name: string;
        }>(`
          SELECT event_object_table AS table_name
            FROM information_schema.triggers
           WHERE trigger_schema = 'agentos'
             AND trigger_name LIKE 'notify_agentos_events_%'
           GROUP BY event_object_table
           ORDER BY event_object_table
        `);

        assert.deepStrictEqual(triggers.map(({ table_name }) => table_name), [
          "agents",
          "external_events",
          "inbox",
          "task_assignments",
          "tasks",
        ]);
      }));
  },
);
