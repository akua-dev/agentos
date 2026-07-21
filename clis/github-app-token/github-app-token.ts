#!/usr/bin/env bun

import { createSign } from "node:crypto";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

type GitHubTokenResponse = {
  token?: unknown;
  expires_at?: unknown;
  permissions?: unknown;
  repository_selection?: unknown;
  repositories?: unknown;
};

type InstallationTokenScope = {
  repositories?: string[];
  repository_ids?: number[];
  permissions?: Record<string, "read" | "write">;
};

type InstallationTokenMetadata = {
  expires_at: string;
  permissions?: Record<string, string>;
  repository_selection?: string;
  repositories?: Array<{ id: number; full_name: string }>;
};

const help = `github-app-token

Mint one short-lived GitHub App installation token.

Usage:
  github-app-token [--scope-file PATH] [--token-file PATH]
                   [--metadata-file PATH]

Required environment:
  GITHUB_APP_ID
  GITHUB_APP_INSTALLATION_ID
  GITHUB_APP_PRIVATE_KEY_FILE

Optional environment:
  GITHUB_API_URL  Defaults to https://api.github.com

Without --token-file, the token is written to standard output. A scope file may
reduce the installation token to selected repositories and permissions. Output
files are replaced atomically with mode 0600; metadata never contains the token.
`;

export function createAppJwt(
  appId: string,
  privateKey: string,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: now - 60,
    exp: now + 540,
    iss: appId,
  })}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  return `${unsigned}.${signer.sign(privateKey, "base64url")}`;
}

export async function mintInstallationToken({
  apiUrl,
  appId,
  installationId,
  privateKey,
  scope,
  request = fetch,
}: {
  apiUrl: string;
  appId: string;
  installationId: string;
  privateKey: string;
  scope?: InstallationTokenScope;
  request?: typeof fetch;
}): Promise<{ token: string; metadata: InstallationTokenMetadata }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${createAppJwt(appId, privateKey)}`,
    "User-Agent": "github-app-token",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (scope) headers["Content-Type"] = "application/json";
  const response = await request(
    `${apiUrl.replace(/\/+$/, "")}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers,
      body: scope ? JSON.stringify(scope) : undefined,
    },
  );
  const body = (await response.json().catch(() => ({}))) as GitHubTokenResponse & {
    message?: unknown;
  };
  if (!response.ok) {
    const message =
      typeof body.message === "string" ? body.message : "provider request failed";
    throw new Error(`${response.status}: ${message}`);
  }
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("GitHub returned no installation token");
  }
  if (typeof body.expires_at !== "string" || body.expires_at.length === 0) {
    throw new Error("GitHub returned no installation token expiry");
  }

  const metadata: InstallationTokenMetadata = { expires_at: body.expires_at };
  if (isStringRecord(body.permissions)) {
    metadata.permissions = body.permissions;
  }
  if (typeof body.repository_selection === "string") {
    metadata.repository_selection = body.repository_selection;
  }
  if (Array.isArray(body.repositories)) {
    metadata.repositories = body.repositories.flatMap((repository) =>
      isRecord(repository) &&
      typeof repository.id === "number" &&
      typeof repository.full_name === "string"
        ? [{ id: repository.id, full_name: repository.full_name }]
        : [],
    );
  }
  return { token: body.token, metadata };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((item) => typeof item === "string")
  );
}

async function readScope(path: string): Promise<InstallationTokenScope> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ConfigurationError(
      `cannot read scope file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) {
    throw new ConfigurationError("scope must be a JSON object");
  }
  const allowed = new Set(["repositories", "repository_ids", "permissions"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new ConfigurationError(`unknown scope field: ${unknown}`);
  }
  if (value.repositories !== undefined && value.repository_ids !== undefined) {
    throw new ConfigurationError(
      "scope must use repositories or repository_ids, not both",
    );
  }

  const scope: InstallationTokenScope = {};
  if (value.repositories !== undefined) {
    if (
      !Array.isArray(value.repositories) ||
      value.repositories.length === 0 ||
      value.repositories.length > 500 ||
      !value.repositories.every(
        (repository) => typeof repository === "string" && repository.length > 0,
      )
    ) {
      throw new ConfigurationError(
        "repositories must contain 1 to 500 repository names",
      );
    }
    scope.repositories = value.repositories as string[];
  }
  if (value.repository_ids !== undefined) {
    if (
      !Array.isArray(value.repository_ids) ||
      value.repository_ids.length === 0 ||
      value.repository_ids.length > 500 ||
      !value.repository_ids.every(
        (id) => Number.isSafeInteger(id) && (id as number) > 0,
      )
    ) {
      throw new ConfigurationError(
        "repository_ids must contain 1 to 500 positive integer IDs",
      );
    }
    scope.repository_ids = value.repository_ids as number[];
  }
  if (value.permissions !== undefined) {
    if (
      !isRecord(value.permissions) ||
      Object.keys(value.permissions).length === 0 ||
      !Object.entries(value.permissions).every(
        ([permission, level]) =>
          permission.length > 0 && (level === "read" || level === "write"),
      )
    ) {
      throw new ConfigurationError(
        "permissions must map permission names to read or write",
      );
    }
    scope.permissions = value.permissions as Record<string, "read" | "write">;
  }
  if (Object.keys(scope).length === 0) {
    throw new ConfigurationError("scope must reduce repositories or permissions");
  }
  return scope;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseArguments(args: string[]): {
  scopeFile?: string;
  tokenFile?: string;
  metadataFile?: string;
} {
  const result: {
    scopeFile?: string;
    tokenFile?: string;
    metadataFile?: string;
  } = {};
  const options: Record<
    string,
    "scopeFile" | "tokenFile" | "metadataFile"
  > = {
    "--scope-file": "scopeFile",
    "--token-file": "tokenFile",
    "--metadata-file": "metadataFile",
  };
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    const key = option ? options[option] : undefined;
    if (!key || !value || value.startsWith("--") || result[key] !== undefined) {
      throw new ConfigurationError(help);
    }
    result[key] = value;
  }
  return result;
}

function requiredPositiveInteger(name: string): string {
  const value = process.env[name];
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  return value;
}

class ConfigurationError extends Error {}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(help);
  } else {
    try {
      const { scopeFile, tokenFile, metadataFile } = parseArguments(
        process.argv.slice(2),
      );
      const appId = requiredPositiveInteger("GITHUB_APP_ID");
      const installationId = requiredPositiveInteger(
        "GITHUB_APP_INSTALLATION_ID",
      );
      const privateKeyFile = process.env.GITHUB_APP_PRIVATE_KEY_FILE;
      if (!privateKeyFile) {
        throw new ConfigurationError(
          "GITHUB_APP_PRIVATE_KEY_FILE must name the mounted private key",
        );
      }
      const privateKey = await readFile(privateKeyFile, "utf8");
      const scope = scopeFile ? await readScope(scopeFile) : undefined;
      const { token, metadata } = await mintInstallationToken({
        apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
        appId,
        installationId,
        privateKey,
        scope,
      });
      if (metadataFile) {
        await atomicWrite(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
      }
      if (tokenFile) {
        await atomicWrite(tokenFile, `${token}\n`);
      } else {
        process.stdout.write(`${token}\n`);
      }
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = error instanceof ConfigurationError ? 2 : 1;
    }
  }
}
