import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);

const ids = {
  crewA: "71000000-0000-4000-8000-000000000003",
  crewB: "71000000-0000-4000-8000-000000000005",
  firstMate: "71000000-0000-4000-8000-000000000001",
  secondA: "71000000-0000-4000-8000-000000000002",
  secondB: "71000000-0000-4000-8000-000000000004",
};
let firstMateHandle: string;

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
  ids.firstMate = root.rows[0]!.id;
  firstMateHandle = root.rows[0]!.handle;

  await database.exec(`
    CREATE ROLE inbox_second_a LOGIN;
    CREATE ROLE inbox_crew_a LOGIN;
    CREATE ROLE inbox_second_b LOGIN;
    CREATE ROLE inbox_crew_b LOGIN;

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES
      (
        '${ids.secondA}', 'inbox-second-a', 'second_mate', '${ids.firstMate}',
        'pi', 'active', 'Second Mate A ready'
      ),
      (
        '${ids.crewA}', 'inbox-crew-a', 'crewmate', '${ids.secondA}',
        'codex', 'active', 'Crewmate A ready'
      ),
      (
        '${ids.secondB}', 'inbox-second-b', 'second_mate', '${ids.firstMate}',
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
});

afterAll(async () => {
  await database.close();
});

describe.serial("Inbox hierarchy-edge routing", () => {
  test("allows delivery in both directions across one direct hierarchy edge", async () => {
    await asRole("inbox_crew_a", () =>
      insertInbox(ids.crewA, "inbox-crew-a", ids.secondA, "question"),
    );
    await asRole("inbox_second_a", () =>
      insertInbox(ids.secondA, "inbox-second-a", ids.crewA, "answer"),
    );

    await asRole("inbox_crew_b", async () => {
      const visible = await database.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM agentos.inbox
      `);
      expect(visible.rows[0]!.count).toBe(2);
    });
  });

  test("rejects delivery without a direct hierarchy edge", async () => {
    await asRole("inbox_crew_a", async () => {
      await expect(
        insertInbox(ids.crewA, "inbox-crew-a", ids.firstMate, "escalation"),
      ).rejects.toThrow();
      await expect(
        insertInbox(ids.crewA, "inbox-crew-a", ids.crewB, "question"),
      ).rejects.toThrow();
      await expect(
        insertInbox(ids.crewA, "inbox-crew-a", ids.crewA, "notification"),
      ).rejects.toThrow();
    });

    await asRole("inbox_second_a", async () => {
      await expect(
        insertInbox(ids.secondA, "inbox-second-a", ids.secondB, "request"),
      ).rejects.toThrow();
    });
  });

  test("applies hierarchy routing to Agent-authored writes by the Fleet owner", async () => {
    await expect(
      insertInbox(ids.firstMate, firstMateHandle, ids.crewA, "request"),
    ).rejects.toThrow();
    await expect(
      insertInbox(ids.firstMate, firstMateHandle, ids.firstMate, "notification"),
    ).rejects.toThrow();
    await expect(
      insertInbox(ids.crewA, "inbox-crew-a", ids.crewA, "captain_decision"),
    ).rejects.toThrow();
  });
});

async function insertInbox(
  senderAgentId: string,
  senderLabel: string,
  recipientAgentId: string,
  kind: string,
) {
  await database.query(
    `
      INSERT INTO agentos.inbox (
        sender_agent_id, sender_label, recipient_agent_id, kind,
        body, status, status_text
      ) VALUES ($1, $2, $3, $4, $5, 'unread', 'Awaiting recipient')
    `,
    [senderAgentId, senderLabel, recipientAgentId, kind, `A ${kind} delivery`],
  );
}

async function asRole<T>(role: string, operation: () => Promise<T>): Promise<T> {
  await database.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await operation();
  } finally {
    await database.exec("SET SESSION AUTHORIZATION postgres");
  }
}
