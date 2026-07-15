import { afterAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import migration from "../migrations/0000_initial_fleet_schema.sql" with {
  type: "text",
};
import behavior from "./0000_initial_fleet_schema.sql" with { type: "text" };

const database = await PGlite.create();

afterAll(async () => {
  await database.close();
});

test("initial migration enforces the fleet coordination contract", async () => {
  await database.exec(migration);
  await database.exec(behavior);

  const tables = await database.query<{ table_name: string }>(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'agentos'
     ORDER BY table_name
  `);

  expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
    "agents",
    "captain",
    "external_events",
    "inbox",
    "learnings",
    "projects",
    "task_assignments",
    "tasks",
  ]);

  const rolledBackRows = await database.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM agentos.agents",
  );
  expect(rolledBackRows.rows[0]?.count).toBe(0);
});
