import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const allowedKinds = [
  "answer",
  "approval",
  "approval_request",
  "captain_decision",
  "captain_decision_answer",
  "escalation",
  "notification",
  "question",
  "request",
];
const recipientId = "72000000-0000-4000-8000-000000000002";

const fleetRoot = Effect.fn("test.inboxVocabulary.fleetRoot")(function*() {
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

const insertInbox = Effect.fn("test.inboxVocabulary.insert")(function*(
  kind: string,
) {
  const database = yield* PGliteTestDatabase;
  const root = yield* fleetRoot();
  yield* database.query(
    `
      INSERT INTO agentos.inbox (
        sender_agent_id, sender_label, recipient_agent_id, kind,
        body, status, status_text
      ) VALUES ($1, $2, $3, $4, $5, 'unread', 'Vocabulary test')
    `,
    [root.id, root.handle, recipientId, kind, `Vocabulary test: ${kind}`],
  );
});

const databaseLayer = makePGliteTestLayer({
  migrations: "all",
  setup: (database) => Effect.gen(function*() {
    const root = yield* database.query<{ readonly id: string }>(`
      SELECT id::text AS id
        FROM agentos.agents
       WHERE role = 'first_mate'
    `);
    const firstMateId = (yield* firstRow(root, "test Fleet has no First Mate")).id;
    yield* database.exec(`
      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES (
        '${recipientId}', 'vocabulary-recipient', 'crewmate', '${firstMateId}',
        'codex', 'active', 'Ready to receive vocabulary tests'
      )
    `);
  }),
});

layer(databaseLayer)("Inbox speech-act vocabulary", (it) => {
  it.effect("rejects an unknown speech-act kind", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(insertInbox("status_ping"));
      assert.strictEqual(error.operation, "query");
    }));

  it.effect("accepts every released speech-act kind", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* Effect.forEach(allowedKinds, insertInbox, { discard: true });

      const stored = yield* database.query<{ readonly kind: string }>(`
        SELECT kind
          FROM agentos.inbox
         WHERE body LIKE 'Vocabulary test:%'
         ORDER BY kind
      `);
      assert.deepStrictEqual(stored.map(({ kind }) => kind), allowedKinds);
    }));

  it.effect("keeps released Captain-decision functions inside the vocabulary", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const root = yield* fleetRoot();
      const tasks = yield* database.query<{ readonly id: string }>(`
        INSERT INTO agentos.tasks (
          created_by_agent_id, title, status, status_text
        ) VALUES (
          '${root.id}', 'Verify decision speech acts', 'active',
          'Ready to exercise decision functions'
        )
        RETURNING id::text AS id
      `);
      const task = yield* firstRow(tasks, "decision test Task was not created");
      const decisions = yield* database.query<{ readonly id: string }>(`
        SELECT agentos.hold_captain_decision(
          '${task.id}',
          'tests.inbox-vocabulary',
          'Choose a test outcome',
          'Should this decision resolve successfully?',
          'Awaiting the test answer'
        )::text AS id
      `);
      const decision = yield* firstRow(
        decisions,
        "Captain decision was not created",
      );
      yield* database.query(`
        SELECT agentos.resolve_captain_decision(
          '${decision.id}',
          'Yes.',
          'The test decision is resolved'
        )
      `);

      const kinds = yield* database.query<{ readonly kind: string }>(`
        SELECT kind
          FROM agentos.inbox
         WHERE decision_key = 'tests.inbox-vocabulary'
            OR reply_to_id = '${decision.id}'
         ORDER BY created_at
      `);
      assert.deepStrictEqual(kinds.map(({ kind }) => kind), [
        "captain_decision",
        "captain_decision_answer",
      ]);
    }));
});
