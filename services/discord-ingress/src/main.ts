#!/usr/bin/env bun

import {
  DiscordConfigurationError,
  requestDiscord,
  resolveDiscordBotToken,
} from "../../../clis/discord/discord.ts";
import {
  DiscordEventRouter,
  type DiscordChannel,
  type DiscordExternalEventSink,
  type DiscordInteractionAcknowledgement,
} from "./events.ts";
import {
  runDiscordGateway,
  type DiscordGatewayOptions,
} from "./gateway.ts";
import { createPostgresExternalEventSink } from "./postgres.ts";

type Environment = Record<string, string | undefined>;
type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DiscordIngressOptions {
  environment?: Environment;
  apiBaseUrl?: string;
  fetchImpl?: FetchImplementation;
  writeLine?: (line: string) => void;
  writeError?: (line: string) => void;
  createSink?: () => Promise<
    DiscordExternalEventSink & { close(): Promise<void> }
  >;
  runGateway?: (options: DiscordGatewayOptions) => Promise<void>;
}

const help = `discord-ingress

Persist approved Discord Gateway messages and interactions for AgentOS reconciliation.

Usage:
  discord-ingress

Requires DATABASE_URL, DISCORD_BOT_TOKEN_FILE (or an approved token
environment), DISCORD_GUILD_ID and DISCORD_MANAGED_CATEGORY_IDS.
`;

export async function runDiscordIngress(
  args: string[],
  options: DiscordIngressOptions = {},
): Promise<number> {
  const environment = options.environment ?? process.env;
  const writeLine = options.writeLine ?? console.log;
  const writeError = options.writeError ?? console.error;
  if (args.includes("--help") || args.includes("-h")) {
    writeLine(help);
    return 0;
  }
  if (args.length > 0) {
    writeError("Usage: discord-ingress");
    return 2;
  }

  let token: string | undefined;
  let databaseUrl: string | undefined;
  let sink:
    | (DiscordExternalEventSink & { close(): Promise<void> })
    | undefined;
  const controller = new AbortController();
  const stop = () => controller.abort();

  try {
    token = await resolveDiscordBotToken(environment);
    databaseUrl = required(environment.DATABASE_URL, "DATABASE_URL");
    const guildId = discordId(environment.DISCORD_GUILD_ID, "DISCORD_GUILD_ID");
    const managedCategoryIds = parseCategoryIds(
      environment.DISCORD_MANAGED_CATEGORY_IDS,
    );
    const apiBaseUrl = options.apiBaseUrl ?? "https://discord.com/api/v10";
    const requestOptions = {
      apiBaseUrl,
      environment,
      fetchImpl: options.fetchImpl,
    };

    const channelsResponse = await requestDiscord(
      "GET",
      `/guilds/${guildId}/channels`,
      requestOptions,
    );
    if (!channelsResponse.ok) {
      throw new Error(
        `Discord guild channels returned HTTP ${channelsResponse.status}`,
      );
    }
    const channels = parseChannels(await channelsResponse.json());

    sink = await (options.createSink ??
      (() => createPostgresExternalEventSink(databaseUrl!)))();
    const router = new DiscordEventRouter({
      guildId,
      managedCategoryIds,
      sink,
      acknowledgeInteraction: (acknowledgement) =>
        acknowledgeDiscordInteraction(acknowledgement, {
          apiBaseUrl,
          fetchImpl: options.fetchImpl,
        }),
      async fetchChannel(channelId) {
        const response = await requestDiscord(
          "GET",
          `/channels/${encodeURIComponent(channelId)}`,
          requestOptions,
        );
        if (response.status === 404) return undefined;
        if (!response.ok) {
          throw new Error(`Discord channel returned HTTP ${response.status}`);
        }
        return parseChannel(await response.json());
      },
    });
    router.seedChannels(channels);

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await (options.runGateway ?? runDiscordGateway)({
      token,
      apiBaseUrl,
      fetchImpl: options.fetchImpl,
      signal: controller.signal,
      onDispatch: (dispatch) => router.handle(dispatch).then(() => undefined),
    });
    await sink.close();
    sink = undefined;
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(redact(message, [token, databaseUrl]));
    if (sink) {
      try {
        await sink.close();
      } catch {
        // The original visible provider or persistence failure remains primary.
      }
    }
    return error instanceof DiscordConfigurationError ||
      isConfigurationError(message)
      ? 2
      : 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function acknowledgeDiscordInteraction(
  acknowledgement: DiscordInteractionAcknowledgement,
  options: {
    apiBaseUrl: string;
    fetchImpl?: FetchImplementation;
  },
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.apiBaseUrl.replace(/\/+$/, "");
  const path = [
    "interactions",
    acknowledgement.interactionId,
    acknowledgement.token,
    "callback",
  ]
    .map(encodeURIComponent)
    .join("/");
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: acknowledgement.responseType }),
    });
  } catch {
    throw new Error("Discord interaction acknowledgement network failure");
  }
  if (!response.ok) {
    throw new Error(
      `Discord interaction acknowledgement returned HTTP ${response.status}`,
    );
  }
}

if (import.meta.main) {
  process.exitCode = await runDiscordIngress(process.argv.slice(2));
}

function required(value: string | undefined, name: string) {
  const normalized = value?.trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function discordId(value: string | undefined, name: string) {
  const normalized = required(value, name);
  if (!/^\d+$/.test(normalized)) {
    throw new TypeError(`${name} must be one Discord snowflake ID`);
  }
  return normalized;
}

function parseCategoryIds(value: string | undefined) {
  const ids = required(value, "DISCORD_MANAGED_CATEGORY_IDS")
    .split(",")
    .map((id) => discordId(id, "DISCORD_MANAGED_CATEGORY_IDS"));
  return [...new Set(ids)];
}

function parseChannels(value: unknown): DiscordChannel[] {
  if (!Array.isArray(value)) {
    throw new Error("Discord guild channels response was not an array");
  }
  return value.map(parseChannel);
}

function parseChannel(value: unknown): DiscordChannel {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Discord returned an invalid channel object");
  }
  const channel = value as Record<string, unknown>;
  if (typeof channel.id !== "string" || typeof channel.type !== "number") {
    throw new Error("Discord returned an invalid channel object");
  }
  return {
    id: channel.id,
    type: channel.type,
    ...(channel.parent_id === null || typeof channel.parent_id === "string"
      ? { parent_id: channel.parent_id }
      : {}),
    ...(typeof channel.guild_id === "string"
      ? { guild_id: channel.guild_id }
      : {}),
  };
}

function redact(message: string, secrets: Array<string | undefined>) {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

function isConfigurationError(message: string) {
  return (
    message.includes(" is required") ||
    message.includes("must be one Discord snowflake ID")
  );
}
