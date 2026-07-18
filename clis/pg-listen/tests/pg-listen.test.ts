import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import * as postgresListener from "../pg-listen.ts";

const cli = resolve(import.meta.dir, "../pg-listen.ts");

describe("pg-listen", () => {
  test("exposes a real help surface without opening a connection", async () => {
    const process = Bun.spawn([cli, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("pg-listen <channel>");
    expect(stdout).not.toContain("AgentOS");
  });

  test("requires a channel before opening a connection", async () => {
    const process = Bun.spawn([cli], {
      env: {
        ...Bun.env,
        PGCONNECT_TIMEOUT: "1",
        PGHOST: "127.0.0.1",
        PGPORT: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Usage: pg-listen <channel>");
  });

  test("listens once on the selected channel and preserves its payload", async () => {
    const wait = (postgresListener as Record<string, unknown>)[
      "waitForNotification"
    ];
    expect(typeof wait).toBe("function");

    const client = new FakePostgresClient();
    const output: string[] = [];
    const waiting = (
      wait as (
        client: FakePostgresClient,
        channel: string,
        write: (text: string) => void,
      ) => Promise<unknown>
    )(client, "fleet.events", (text) => output.push(text));

    await client.listening;
    expect(client.queries).toEqual(['LISTEN "fleet.events"']);
    client.emit("notification", {
      channel: "other_channel",
      payload: "ignored",
    });
    client.emit("notification", {
      channel: "fleet.events",
      payload: JSON.stringify({ version: 1, table: "inbox", operation: "insert" }),
    });

    await expect(waiting).resolves.toEqual({
      channel: "fleet.events",
      payload: '{"version":1,"table":"inbox","operation":"insert"}',
    });
    expect(output).toEqual([
      '{"channel":"fleet.events","payload":"{\\"version\\":1,\\"table\\":\\"inbox\\",\\"operation\\":\\"insert\\"}"}\n',
    ]);
    expect(client.ended).toBe(true);
  });

  test("closes the connection when the output consumer fails", async () => {
    const client = new FakePostgresClient();
    const waiting = (
      postgresListener as Record<string, unknown>
    ).waitForNotification as (
      client: FakePostgresClient,
      channel: string,
      write: (text: string) => void,
    ) => Promise<unknown>;
    const result = waiting(client, "agentos_events", () => {
      throw new Error("output failed");
    });

    await client.listening;
    client.emit("notification", {
      channel: "agentos_events",
      payload: "{}",
    });

    await expect(result).rejects.toThrow("output failed");
    expect(client.ended).toBe(true);
  });
});

class FakePostgresClient extends EventEmitter {
  readonly queries: string[] = [];
  ended = false;
  readonly listening: Promise<void>;
  #resolveListening!: () => void;

  constructor() {
    super();
    this.listening = new Promise<void>((resolve) => {
      this.#resolveListening = resolve;
    });
  }

  async connect() {}

  async query(statement: string) {
    this.queries.push(statement);
    this.#resolveListening();
    return {};
  }

  async end() {
    this.ended = true;
  }
}
