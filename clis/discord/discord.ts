#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { encode } from "@toon-format/toon";

const help = `discord

Make one authenticated Discord HTTP API request.

Usage:
  discord request <METHOD> </relative/api/path> [--axi [--full]]

The bot token is read from DISCORD_BOT_TOKEN_FILE, or from
DISCORD_BOT_TOKEN when an approved environment secret is used. A request body
is read from standard input. The provider response is written unchanged unless
--axi selects a compact agent-readable TOON view. Add --full for complete TOON.
`;

type Environment = Record<string, string | undefined>;
type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

class DiscordUsageError extends Error {}
class DiscordAxiOutputError extends Error {}

const usage =
  "Usage: discord request <METHOD> </relative/api/path> [--axi [--full]]";

export interface DiscordCliOptions {
  environment?: Environment;
  apiBaseUrl?: string;
  fetchImpl?: FetchImplementation;
  readStdin?: () => Promise<string>;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
}

export async function resolveDiscordBotToken(
  environment: Environment,
): Promise<string> {
  const tokenFile = environment.DISCORD_BOT_TOKEN_FILE?.trim();
  const token = tokenFile
    ? (await readFile(tokenFile, "utf8")).trim()
    : environment.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN_FILE or DISCORD_BOT_TOKEN is required",
    );
  }
  return token;
}

export async function requestDiscord(
  method: string,
  path: string,
  options: DiscordCliOptions = {},
): Promise<Response> {
  const environment = options.environment ?? process.env;
  const apiBaseUrl = options.apiBaseUrl ?? "https://discord.com/api/v10";
  const url = resolveDiscordApiUrl(apiBaseUrl, path);
  const normalizedMethod = method.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalizedMethod)) {
    throw new DiscordUsageError(
      "Discord HTTP method must contain only letters",
    );
  }
  const token = await resolveDiscordBotToken(environment);
  const body =
    normalizedMethod === "GET" || normalizedMethod === "HEAD"
      ? ""
      : await (options.readStdin ?? (() => Bun.stdin.text()))();
  try {
    return await (options.fetchImpl ?? fetch)(url, {
      method: normalizedMethod,
      headers: {
        authorization: `Bot ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll(token, "[REDACTED]"));
  }
}

export async function runDiscordCli(
  args: string[],
  options: DiscordCliOptions = {},
): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const writeError =
    options.writeError ?? ((text: string) => process.stderr.write(text));
  if (args.includes("--help") || args.includes("-h")) {
    write(help);
    return 0;
  }

  const [command, method, path, ...flags] = args;
  const axi = flags.includes("--axi");
  const full = flags.includes("--full");
  const recognizedFlags = flags.every(
    (flag) => flag === "--axi" || flag === "--full",
  );
  if (
    command !== "request" ||
    !method ||
    !path ||
    !recognizedFlags ||
    new Set(flags).size !== flags.length ||
    (full && !axi)
  ) {
    if (axi) {
      write(
        `${encode({
          error: { code: "discord_usage", message: usage },
        })}\n`,
      );
    } else {
      writeError(`${usage}\n`);
    }
    return 2;
  }

  try {
    const response = await requestDiscord(method, path, options);
    const body = await response.text();
    if (!response.ok) {
      if (axi) {
        write(renderAxiError(response.status, body, full));
      } else {
        writeError(body);
      }
      return 1;
    }
    write(axi ? renderAxiSuccess(method, path, body, full) : body);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = redact(message, options.environment ?? process.env);
    const configurationFailure = message.includes("DISCORD_BOT_TOKEN");
    const exitCode =
      error instanceof DiscordUsageError || configurationFailure ? 2 : 1;
    if (axi) {
      const code = classifyAxiError(error, configurationFailure);
      write(
        `${encode({
          error: {
            code,
            message: redacted,
            ...(error instanceof DiscordAxiOutputError
              ? { help: "Retry without --axi to inspect the raw response." }
              : {}),
          },
        })}\n`,
      );
    } else {
      writeError(`${redacted}\n`);
    }
    return exitCode;
  }
}

function classifyAxiError(
  error: unknown,
  configurationFailure: boolean,
): string {
  if (error instanceof DiscordUsageError) return "discord_usage";
  if (error instanceof DiscordAxiOutputError) return "discord_axi_output";
  if (configurationFailure) return "discord_configuration";
  return "discord_request_failed";
}

function renderAxiError(status: number, body: string, full: boolean): string {
  let provider: unknown;
  try {
    provider = JSON.parse(body) as unknown;
  } catch {
    provider = body;
  }
  const details =
    typeof provider === "object" && provider !== null
      ? (provider as Record<string, unknown>)
      : {};
  const error = {
    code: `discord_http_${status}`,
    status,
    message:
      typeof details.message === "string"
        ? details.message
        : "Discord request failed",
    ...(details.code !== undefined ? { provider_code: details.code } : {}),
    ...(details.retry_after !== undefined
      ? { retry_after: details.retry_after }
      : {}),
    ...(full ? { provider } : {}),
  };
  return `${encode({ error })}\n`;
}

function renderAxiSuccess(
  method: string,
  path: string,
  body: string,
  full: boolean,
): string {
  if (!body.trim()) {
    return `${encode({ result: { ok: true, empty: true } })}\n`;
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new DiscordAxiOutputError(
      "Discord returned a non-JSON success response.",
    );
  }
  if (!full && method.toUpperCase() !== "GET" && isDiscordMessage(value)) {
    return `${encode({
      message: {
        id: value.id,
        channel_id: value.channel_id,
        timestamp: value.timestamp ?? null,
        embed_count: Array.isArray(value.embeds) ? value.embeds.length : 0,
        component_count: Array.isArray(value.components)
          ? value.components.length
          : 0,
      },
    })}\n`;
  }
  if (!full && method.toUpperCase() === "GET" && isDiscordMessage(value)) {
    return `${encode({ message: projectDiscordMessage(value) })}\n`;
  }
  if (
    !full &&
    method.toUpperCase() === "GET" &&
    Array.isArray(value) &&
    (value.length === 0
      ? isDiscordMessagesPath(path)
      : value.every(isDiscordMessage))
  ) {
    const messages = value as Array<Record<string, unknown>>;
    const visible = messages.slice(0, 20).map(projectDiscordMessage);
    return `${encode({
      summary: {
        empty: messages.length === 0,
        returned_count: visible.length,
        omitted_count: messages.length - visible.length,
      },
      messages: visible,
    })}\n`;
  }
  return `${encode(value)}\n`;
}

function projectDiscordMessage(value: Record<string, unknown>) {
  const author =
    typeof value.author === "object" && value.author !== null
      ? (value.author as Record<string, unknown>)
      : {};
  return {
    id: value.id,
    author: author.global_name ?? author.username ?? author.id ?? null,
    timestamp: value.timestamp ?? null,
    content: value.content ?? "",
  };
}

function isDiscordMessagesPath(path: string): boolean {
  return /^\/channels\/[^/]+\/messages(?:\?|$)/.test(path);
}

function isDiscordMessage(
  value: unknown,
): value is Record<string, unknown> & { id: string; channel_id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).id === "string" &&
    typeof (value as Record<string, unknown>).channel_id === "string"
  );
}

function resolveDiscordApiUrl(apiBaseUrl: string, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new DiscordUsageError(
      "request requires one relative Discord API path",
    );
  }
  const base = new URL(apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`);
  const url = new URL(path.slice(1), base);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname)
  ) {
    throw new DiscordUsageError(
      "request requires one relative Discord API path",
    );
  }
  return url;
}

function redact(message: string, environment: Environment) {
  const token = environment.DISCORD_BOT_TOKEN?.trim();
  return token ? message.replaceAll(token, "[REDACTED]") : message;
}

if (import.meta.main) {
  process.exitCode = await runDiscordCli(process.argv.slice(2));
}
