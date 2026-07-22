import { describe, expect, test } from "bun:test";
import {
  PostgresExternalEventSink,
  type PostgresQueryClient,
} from "../src/postgres.ts";
import type { DiscordExternalEvent } from "../src/events.ts";

describe("Discord PostgreSQL ingress", () => {
  test("calls only the released external-event ingestion function with parameters", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client: PostgresQueryClient = {
      async query(text, values) {
        queries.push({ text, values });
        return { rows: [{ id: 91 }] };
      },
      async end() {},
    };
    const sink = new PostgresExternalEventSink(client);
    const event: DiscordExternalEvent = {
      provider: "discord",
      deliveryId: "MESSAGE_CREATE:123",
      eventType: "MESSAGE_CREATE",
      coalesceKey: "discord:channel:456",
      actorExternalId: "789",
      payload: {
        op: 0,
        t: "MESSAGE_CREATE",
        s: 7,
        d: { id: "123", channel_id: "456", content: "Captain intent" },
      },
      requestMetadata: {
        source: "gateway",
        sequence: 7,
        channel_id: "456",
      },
    };

    await sink.ingest(event);

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("agentos.ingest_external_event");
    expect(queries[0]?.text).not.toContain("INSERT INTO");
    expect(queries[0]?.values).toEqual([
      "discord",
      "MESSAGE_CREATE:123",
      "MESSAGE_CREATE",
      "discord:channel:456",
      JSON.stringify(event.payload),
      "789",
      JSON.stringify(event.requestMetadata),
    ]);
  });
});
