import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const ids = {
  crewA: "71000000-0000-4000-8000-000000000003",
  crewB: "71000000-0000-4000-8000-000000000005",
  secondA: "71000000-0000-4000-8000-000000000002",
  secondB: "71000000-0000-4000-8000-000000000004",
};
const fleetRoot = Effect.fn("test.inboxRouting.fleetRoot")(function*() {
  const database = yield* PGliteTestDatabase;
  const rows = yield* database.query<{
    readonly handle: string;
    readonly id: string;
  }>(`
    SELECT id::text AS id, handle
      FROM agentos.agents
     WHERE role = 'first_mate'
  `);
  return yield* firstRow(rows, "test Fleet has no First Mate");
});

const insertInbox = Effect.fn("test.inboxRouting.insert")(function*(
  senderAgentId: string,
  senderLabel: string,
  recipientAgentId: string,
  kind: string,
) {
  const database = yield* PGliteTestDatabase;
  yield* database.query(
    `
      INSERT INTO agentos.inbox (
        sender_agent_id, sender_label, recipient_agent_id, kind,
        body, status, status_text
      ) VALUES ($1, $2, $3, $4, $5, 'unread', 'Awaiting recipient')
    `,
    [senderAgentId, senderLabel, recipientAgentId, kind, `A ${kind} delivery`],
  );
});

const databaseLayer = makePGliteTestLayer({
  migrations: "all",
  setup: (database) => Effect.gen(function*() {
    const roots = yield* database.query<{ readonly id: string }>(`
      SELECT id::text AS id
        FROM agentos.agents
       WHERE role = 'first_mate'
    `);
    const firstMateId = (yield* firstRow(
      roots,
      "test Fleet has no First Mate",
    )).id;

    yield* database.exec(`
      CREATE ROLE inbox_second_a LOGIN;
      CREATE ROLE inbox_crew_a LOGIN;
      CREATE ROLE inbox_second_b LOGIN;
      CREATE ROLE inbox_crew_b LOGIN;

      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES
        (
          '${ids.secondA}', 'inbox-second-a', 'second_mate', '${firstMateId}',
          'pi', 'active', 'Second Mate A ready'
        ),
        (
          '${ids.crewA}', 'inbox-crew-a', 'crewmate', '${ids.secondA}',
          'codex', 'active', 'Crewmate A ready'
        ),
        (
          '${ids.secondB}', 'inbox-second-b', 'second_mate', '${firstMateId}',
          'pi', 'active', 'Second Mate B ready'
        ),
        (
          '${ids.crewB}', 'inbox-crew-b', 'crewmate', '${ids.secondB}',
          'codex', 'active', 'Crewmate B ready'
        );

      SELECT agentos.register_agent_principal('${ids.secondA}', 'inbox_second_a');
      SELECT agentos.register_agent_principal('${ids.crewA}', 'inbox_crew_a');
      SELECT agentos.register_agent_principal('${ids.secondB}', 'inbox_second_b');
      SELECT agentos.register_agent_principal('${ids.crewB}', 'inbox_crew_b');
    `);
  }),
});

layer(databaseLayer)("Inbox hierarchy-edge routing", (it) => {
  it.effect("allows delivery in both directions across one direct hierarchy edge", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin(
        "inbox_crew_a",
        insertInbox(ids.crewA, "inbox-crew-a", ids.secondA, "question"),
      );
      yield* asLogin(
        "inbox_second_a",
        insertInbox(ids.secondA, "inbox-second-a", ids.crewA, "answer"),
      );

      const visible = yield* asLogin(
        "inbox_crew_b",
        database.query<{ readonly count: number }>(`
          SELECT count(*)::int AS count FROM agentos.inbox
        `),
      );
      assert.strictEqual(
        (yield* firstRow(visible, "missing inbox visibility count")).count,
        2,
      );
    }));

  it.effect("rejects delivery without a direct hierarchy edge", () =>
    Effect.gen(function*() {
      const root = yield* fleetRoot();
      const attempts = [
        asLogin(
          "inbox_crew_a",
          insertInbox(ids.crewA, "inbox-crew-a", root.id, "escalation"),
        ),
        asLogin(
          "inbox_crew_a",
          insertInbox(ids.crewA, "inbox-crew-a", ids.crewB, "question"),
        ),
        asLogin(
          "inbox_crew_a",
          insertInbox(ids.crewA, "inbox-crew-a", ids.crewA, "notification"),
        ),
        asLogin(
          "inbox_second_a",
          insertInbox(ids.secondA, "inbox-second-a", ids.secondB, "request"),
        ),
      ];
      const errors = yield* Effect.forEach(attempts, Effect.flip);
      assert.isTrue(errors.every((error) => error.operation === "query"));
    }));

  it.effect("applies hierarchy routing to Fleet-owner Agent writes", () =>
    Effect.gen(function*() {
      const root = yield* fleetRoot();
      const attempts = [
        insertInbox(root.id, root.handle, ids.crewA, "request"),
        insertInbox(root.id, root.handle, root.id, "notification"),
        insertInbox(ids.crewA, "inbox-crew-a", ids.crewA, "captain_decision"),
      ];
      const errors = yield* Effect.forEach(attempts, Effect.flip);
      assert.isTrue(errors.every((error) => error.operation === "query"));
    }));
});
