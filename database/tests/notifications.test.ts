import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);
const notifications: string[] = [];
let unlisten: (() => Promise<void>) | undefined;

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
  unlisten = await database.listen("agentos_events", (payload) => {
    notifications.push(payload);
  });
});

afterAll(async () => {
  await unlisten?.();
  await database.close();
});

describe.serial("Fleet notifications", () => {
  test("notifies after commit and leaves the durable row authoritative", async () => {
    const root = await database.query<{ id: string }>(`
      SELECT id::text AS id
        FROM agentos.agents
       WHERE role = 'first_mate'
    `);
    const rootId = root.rows[0]!.id;

    await database.exec(`
      UPDATE agentos.agents
         SET status_text = 'Notification test committed'
       WHERE id = '${rootId}'
    `);
    await waitFor(() => notifications.length === 1);

    expect(JSON.parse(notifications[0]!)).toEqual({
      version: 1,
      table: "agents",
      operation: "update",
    });
    const durable = await database.query<{ status_text: string }>(`
      SELECT status_text
        FROM agentos.agents
       WHERE id = '${rootId}'
    `);
    expect(durable.rows[0]!.status_text).toBe("Notification test committed");
  });

  test("emits nothing for rolled-back changes", async () => {
    const countBefore = notifications.length;
    await database.exec(`
      BEGIN;
      UPDATE agentos.agents
         SET status_text = 'Notification test rolled back'
       WHERE role = 'first_mate';
      ROLLBACK;
    `);
    await Bun.sleep(25);

    expect(notifications).toHaveLength(countBefore);
  });

  test("covers the actionable coordination tables", async () => {
    const triggers = await database.query<{ table_name: string }>(`
      SELECT event_object_table AS table_name
        FROM information_schema.triggers
       WHERE trigger_schema = 'agentos'
         AND trigger_name LIKE 'notify_agentos_events_%'
       GROUP BY event_object_table
       ORDER BY event_object_table
    `);

    expect(triggers.rows.map(({ table_name }) => table_name)).toEqual([
      "agents",
      "captain",
      "external_events",
      "inbox",
      "task_assignments",
      "tasks",
    ]);
  });
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 500;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
