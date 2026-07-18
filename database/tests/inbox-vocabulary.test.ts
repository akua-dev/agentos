import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);
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
] as const;

let firstMateId: string;
let firstMateHandle: string;
const recipientId = "72000000-0000-4000-8000-000000000002";

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

  const root = await database.query<{ handle: string; id: string }>(`
    SELECT id::text AS id, handle
      FROM agentos.agents
     WHERE role = 'first_mate'
  `);
  firstMateId = root.rows[0]!.id;
  firstMateHandle = root.rows[0]!.handle;

  await database.exec(`
    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES (
      '${recipientId}', 'vocabulary-recipient', 'crewmate', '${firstMateId}',
      'codex', 'active', 'Ready to receive vocabulary tests'
    )
  `);
});

afterAll(async () => {
  await database.close();
});

describe.serial("Inbox speech-act vocabulary", () => {
  test("rejects an unknown speech-act kind", async () => {
    await expect(insertInbox("status_ping")).rejects.toThrow();
  });

  test("accepts every released speech-act kind", async () => {
    for (const kind of allowedKinds) await insertInbox(kind);

    const stored = await database.query<{ kind: string }>(`
      SELECT kind
        FROM agentos.inbox
       WHERE body LIKE 'Vocabulary test:%'
       ORDER BY kind
    `);
    expect(stored.rows.map(({ kind }) => kind)).toEqual([...allowedKinds]);
  });

  test("keeps released Captain-decision functions inside the vocabulary", async () => {
    const task = await database.query<{ id: string }>(`
      INSERT INTO agentos.tasks (
        created_by_agent_id, title, status, status_text
      ) VALUES (
        '${firstMateId}', 'Verify decision speech acts', 'active',
        'Ready to exercise decision functions'
      )
      RETURNING id::text AS id
    `);
    const decision = await database.query<{ id: string }>(`
      SELECT agentos.hold_captain_decision(
        '${task.rows[0]!.id}',
        'tests.inbox-vocabulary',
        'Choose a test outcome',
        'Should this decision resolve successfully?',
        'Awaiting the test answer'
      )::text AS id
    `);
    await database.query(`
      SELECT agentos.resolve_captain_decision(
        '${decision.rows[0]!.id}',
        'Yes.',
        'The test decision is resolved'
      )
    `);

    const kinds = await database.query<{ kind: string }>(`
      SELECT kind
        FROM agentos.inbox
       WHERE decision_key = 'tests.inbox-vocabulary'
          OR reply_to_id = '${decision.rows[0]!.id}'
       ORDER BY created_at
    `);
    expect(kinds.rows.map(({ kind }) => kind)).toEqual([
      "captain_decision",
      "captain_decision_answer",
    ]);
  });
});

async function insertInbox(kind: string) {
  await database.query(
    `
      INSERT INTO agentos.inbox (
        sender_agent_id, sender_label, recipient_agent_id, kind,
        body, status, status_text
      ) VALUES ($1, $2, $3, $4, $5, 'unread', 'Vocabulary test')
    `,
    [firstMateId, firstMateHandle, recipientId, kind, `Vocabulary test: ${kind}`],
  );
}
