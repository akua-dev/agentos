import type {
  DiscordExternalEvent,
  DiscordExternalEventSink,
} from "./events.ts";
import { Client } from "pg";
import { resolvePgPassDatabaseUrl } from "../../../database/runtime/database-credentials.ts";

export interface PostgresQueryClient {
  query(text: string, values: unknown[]): Promise<unknown>;
  end(): Promise<unknown>;
}

export class PostgresExternalEventSink implements DiscordExternalEventSink {
  constructor(private readonly client: PostgresQueryClient) {}

  async ingest(event: DiscordExternalEvent): Promise<void> {
    await this.client.query(
      `SELECT agentos.ingest_external_event(
         $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb
       )`,
      [
        event.provider,
        event.deliveryId,
        event.eventType,
        event.coalesceKey,
        JSON.stringify(event.payload),
        event.actorExternalId ?? null,
        JSON.stringify(event.requestMetadata),
      ],
    );
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

export async function createPostgresExternalEventSink(
  databaseUrl: string,
): Promise<PostgresExternalEventSink> {
  const client = new Client({
    application_name: "discord-ingress",
    connectionString: resolvePgPassDatabaseUrl(databaseUrl),
  });
  await client.connect();
  return new PostgresExternalEventSink(client as PostgresQueryClient);
}
