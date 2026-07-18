import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);
const ids = {
  crewA: "72000000-0000-4000-8000-000000000003",
  crewB: "72000000-0000-4000-8000-000000000004",
  firstMate: "72000000-0000-4000-8000-000000000001",
  secondMate: "72000000-0000-4000-8000-000000000002",
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
    CREATE ROLE receipt_second LOGIN;
    CREATE ROLE receipt_crew_a LOGIN;
    CREATE ROLE receipt_crew_b LOGIN;

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES
      (
        '${ids.secondMate}', 'receipt-second', 'second_mate', '${ids.firstMate}',
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
});

afterAll(async () => {
  await database.close();
});

describe.serial("Inbox receipt", () => {
  test("atomically returns and marks a delivery loaded by its recipient", async () => {
    const inboxId = await insertRequest("Recipient should load this request");

    const firstReceipt = await asRole("receipt_crew_a", () => receive(inboxId));
    expect(firstReceipt.body).toBe("Recipient should load this request");
    expect(firstReceipt.status).toBe("read");
    expect(firstReceipt.status_text).toBe("Received by receipt-crew-a");
    expect(firstReceipt.read_at).not.toBeNull();
    expect(firstReceipt.resolved_at).toBeNull();

    const repeatedReceipt = await asRole("receipt_crew_a", () => receive(inboxId));
    expect(repeatedReceipt.read_at).toBe(firstReceipt.read_at);
    expect(repeatedReceipt.resolved_at).toBeNull();
  });

  test("rejects acknowledgment by an unrelated Agent", async () => {
    const inboxId = await insertRequest("Only the addressed Crewmate may receive this");

    await expect(
      asRole("receipt_crew_b", () => receive(inboxId)),
    ).rejects.toThrow();
    await expect(
      asRole("receipt_second", () => receive(inboxId)),
    ).rejects.toThrow();
  });

  test("preserves First Mate administrative receipt capability", async () => {
    const inboxId = await insertRequest("First Mate may repair receipt state");

    const receipt = await receive(inboxId);
    expect(receipt.status).toBe("read");
    expect(receipt.status_text).toBe("Administratively received by First Mate");
    expect(receipt.read_at).not.toBeNull();
    expect(receipt.resolved_at).toBeNull();
  });
});

async function insertRequest(body: string): Promise<string> {
  return asRole("receipt_second", async () => {
    const result = await database.query<{ id: string }>(
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
    );
    return result.rows[0]!.id;
  });
}

async function receive(inboxId: string) {
  const result = await database.query<{
    body: string;
    read_at: string | null;
    resolved_at: string | null;
    status: string;
    status_text: string;
  }>(
    `
      SELECT body, status, status_text, read_at::text, resolved_at::text
        FROM agentos.receive_inbox($1)
    `,
    [inboxId],
  );
  if (!result.rows[0]) throw new Error("Inbox receipt returned no row");
  return result.rows[0];
}

async function asRole<T>(role: string, operation: () => Promise<T>): Promise<T> {
  await database.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await operation();
  } finally {
    await database.exec("SET SESSION AUTHORIZATION postgres");
  }
}
