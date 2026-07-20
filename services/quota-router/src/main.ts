#!/usr/bin/env bun

import { homedir } from "node:os";
import { join } from "node:path";
import {
  loginOpenAICodexDeviceCode,
  refreshOpenAICodexToken,
  type OAuthCredentials,
  type OAuthDeviceCodeInfo,
} from "@earendil-works/pi-ai/oauth";
import { createAccountVault, createAccountVaultStore } from "./accounts.ts";
import { createQuotaRouterService } from "./service.ts";

type Environment = Record<string, string | undefined>;
type LoginImplementation = (options: {
  onDeviceCode(info: OAuthDeviceCodeInfo): void;
  signal?: AbortSignal;
}) => Promise<OAuthCredentials>;
type RefreshImplementation = (refreshToken: string) => Promise<OAuthCredentials>;
type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ServerHandle {
  stop(closeActiveConnections?: boolean): unknown;
}

export interface RunQuotaRouterCliOptions {
  environment?: Environment;
  writeLine?: (line: string) => void;
  writeError?: (line: string) => void;
  login?: LoginImplementation;
  refresh?: RefreshImplementation;
  fetchImpl?: FetchImplementation;
  startServer?: (options: {
    hostname: string;
    port: number;
    fetch(request: Request): Response | Promise<Response>;
  }) => ServerHandle;
  waitForShutdown?: () => Promise<void>;
}

export async function runQuotaRouterCli(
  args: string[],
  options: RunQuotaRouterCliOptions = {},
): Promise<number> {
  const environment = options.environment ?? process.env;
  const writeLine = options.writeLine ?? console.log;
  const writeError = options.writeError ?? console.error;
  const stateDirectory =
    environment.QUOTA_ROUTER_STATE_DIR ?? join(homedir(), ".local", "state", "quota-router");
  const refresh = options.refresh ?? refreshOpenAICodexToken;
  const vault = createAccountVault({
    store: createAccountVaultStore(join(stateDirectory, "accounts.json")),
    refreshDirectory: stateDirectory,
    oauth: { refresh },
    clock: Date.now,
  });
  const command = args[0] ?? "help";

  try {
    if (command === "login") {
      const label = args.slice(1).join(" ").trim() || "Codex account";
      const credentials = await (options.login ?? loginOpenAICodexDeviceCode)({
        onDeviceCode(info) {
          writeLine(`Open ${info.verificationUri}`);
          writeLine(`Enter code ${info.userCode}`);
        },
      });
      const id = await vault.addFromOAuth(label, credentials);
      writeLine(`Added ${label} (${id})`);
      return 0;
    }

    if (command === "list") {
      const accounts = await vault.list();
      if (accounts.length === 0) {
        writeLine("No Codex accounts configured");
        return 0;
      }
      for (const account of accounts) {
        writeLine(
          `${account.id}\t${account.label}\t${account.needsReauth ? "needs_reauth" : "ready"}`,
        );
      }
      return 0;
    }

    if (command === "status") {
      const clientToken = environment.QUOTA_ROUTER_TOKEN?.trim();
      if (!clientToken) {
        writeError("QUOTA_ROUTER_TOKEN is required for status");
        return 1;
      }
      const response = await (options.fetchImpl ?? fetch)(
        `http://127.0.0.1:${parsePort(environment.QUOTA_ROUTER_PORT)}/status`,
        { headers: { authorization: `Bearer ${clientToken}` } },
      );
      if (!response.ok) {
        writeError(`quota-router status returned HTTP ${response.status}`);
        return 1;
      }
      writeLine(await response.text());
      return 0;
    }

    if (command === "remove") {
      const id = args[1];
      if (!id) {
        writeError("remove requires an opaque account ID from quota-router list");
        return 2;
      }
      if (!(await vault.remove(id))) {
        writeError(`No managed account exists for ${id}`);
        return 1;
      }
      writeLine(`Removed ${id}`);
      return 0;
    }

    if (command === "serve") {
      const clientToken = environment.QUOTA_ROUTER_TOKEN?.trim();
      if (!clientToken) {
        writeError("QUOTA_ROUTER_TOKEN is required to serve");
        return 1;
      }
      const service = await createQuotaRouterService({
        stateDirectory,
        clientToken,
        allowApiKeyFallback: environment.QUOTA_ROUTER_ALLOW_API_KEY_FALLBACK === "true",
        ...(environment.OPENAI_API_KEY ? { openAIApiKey: environment.OPENAI_API_KEY } : {}),
        oauth: { refresh },
        fetchImpl: options.fetchImpl ?? fetch,
      });
      const hostname = environment.QUOTA_ROUTER_HOST ?? "0.0.0.0";
      const port = parsePort(environment.QUOTA_ROUTER_PORT);
      const server = (options.startServer ?? defaultStartServer)({
        hostname,
        port,
        fetch: service.fetch,
      });
      writeLine(`quota-router listening on ${hostname}:${port}`);
      await (options.waitForShutdown ?? waitForShutdown)();
      await server.stop(false);
      return 0;
    }

    writeLine("Usage: quota-router <serve|login [label]|list|status|remove <id>>");
    return command === "help" || command === "--help" || command === "-h" ? 0 : 2;
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    writeError(`quota-router ${command} failed (${name})`);
    return 1;
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("QUOTA_ROUTER_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function defaultStartServer(options: {
  hostname: string;
  port: number;
  fetch(request: Request): Response | Promise<Response>;
}): ServerHandle {
  return Bun.serve(options);
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

if (import.meta.main) {
  process.exitCode = await runQuotaRouterCli(process.argv.slice(2));
}
