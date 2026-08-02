import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const ids = {
  crewA: "72000000-0000-4000-8000-000000000003",
  crewB: "72000000-0000-4000-8000-000000000004",
  secondMate: "72000000-0000-4000-8000-000000000002",
};

const insertRequest = Effect.fn("test.inboxReceipt.insertRequest")(function*(
  body: string,
) {
  const database = yield* PGliteTestDatabase;
  const result = yield* asLogin(
    "receipt_second",
    database.query<{ readonly id: string }>(
      `
        INSERT INTO agentos.inbox (
          sender_agent_id, sender_label, recipient_agent_id, kind, subject,
          body, status, status_text
        ) VALUES (
          $1, 'receipt-second', $2, 'request', 'Review requested',
          $3, 'unread', 'Awaiting recipient'
        )
        RETURNING id::text AS id
      `,
      [ids.secondMate, ids.crewA, body],
    ),
  );
  return (yield* firstRow(result, "Inbox request insert returned no row")).id;
});

const receive = Effect.fn("test.inboxReceipt.receive")(function*(
  inboxId: string,
) {
  const database = yield* PGliteTestDatabase;
  const result = yield* database.query<{
    readonly body: string;
    readonly read_at: string | null;
    readonly resolved_at: string | null;
    readonly status: string;
    readonly status_text: string;
  }>(
    `
      SELECT body, status, status_text, read_at::text, resolved_at::text
        FROM agentos.receive_inbox($1)
    `,
    [inboxId],
  );
  return yield* firstRow(result, "Inbox receipt returned no row");
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
      CREATE ROLE receipt_second LOGIN;
      CREATE ROLE receipt_crew_a LOGIN;
      CREATE ROLE receipt_crew_b LOGIN;

      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES
        (
          '${ids.secondMate}', 'receipt-second', 'second_mate', '${firstMateId}',
          'pi', 'active', 'Second Mate ready'
        ),
        (
          '${ids.crewA}', 'receipt-crew-a', 'crewmate', '${ids.secondMate}',
          'codex', 'active', 'Crewmate A ready'
        ),
        (
          '${ids.crewB}', 'receipt-crew-b', 'crewmate', '${ids.secondMate}',
          'codex', 'active', 'Crewmate B ready'
        );

      SELECT agentos.register_agent_principal('${ids.secondMate}', 'receipt_second');
      SELECT agentos.register_agent_principal('${ids.crewA}', 'receipt_crew_a');
      SELECT agentos.register_agent_principal('${ids.crewB}', 'receipt_crew_b');
    `);
  }),
});

layer(databaseLayer)("Inbox receipt", (it) => {
  it.effect("atomically returns and marks a delivery loaded by its recipient", () =>
    Effect.gen(function*() {
      const inboxId = yield* insertRequest("Recipient should load this request");
      const firstReceipt = yield* asLogin("receipt_crew_a", receive(inboxId));
      assert.strictEqual(firstReceipt.body, "Recipient should load this request");
      assert.strictEqual(firstReceipt.status, "read");
      assert.strictEqual(firstReceipt.status_text, "Received by receipt-crew-a");
      assert.isNotNull(firstReceipt.read_at);
      assert.isNull(firstReceipt.resolved_at);

      const repeatedReceipt = yield* asLogin("receipt_crew_a", receive(inboxId));
      assert.strictEqual(repeatedReceipt.read_at, firstReceipt.read_at);
      assert.isNull(repeatedReceipt.resolved_at);
    }));

  it.effect("rejects acknowledgment by an unrelated Agent", () =>
    Effect.gen(function*() {
      const inboxId = yield* insertRequest(
        "Only the addressed Crewmate may receive this",
      );
      const errors = yield* Effect.forEach([
        asLogin("receipt_crew_b", receive(inboxId)),
        asLogin("receipt_second", receive(inboxId)),
      ], Effect.flip);
      assert.isTrue(errors.every((error) => error.operation === "query"));
    }));

  it.effect("preserves First Mate administrative receipt capability", () =>
    Effect.gen(function*() {
      const inboxId = yield* insertRequest("First Mate may repair receipt state");
      const receipt = yield* receive(inboxId);
      assert.strictEqual(receipt.status, "read");
      assert.strictEqual(
        receipt.status_text,
        "Administratively received by First Mate",
      );
      assert.isNotNull(receipt.read_at);
      assert.isNull(receipt.resolved_at);
    }));
});
