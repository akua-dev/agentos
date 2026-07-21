#!/usr/bin/env bun

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

type GitHubTokenResponse = {
  token?: unknown;
};

const help = `github-app-token

Mint one short-lived GitHub App installation token.

Usage:
  github-app-token

Required environment:
  GITHUB_APP_ID
  GITHUB_APP_INSTALLATION_ID
  GITHUB_APP_PRIVATE_KEY_FILE

Optional environment:
  GITHUB_API_URL  Defaults to https://api.github.com

The token is written to standard output. Consume it through a standard provider
environment such as GH_TOKEN without logging or persisting it.
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
  request = fetch,
}: {
  apiUrl: string;
  appId: string;
  installationId: string;
  privateKey: string;
  request?: typeof fetch;
}): Promise<string> {
  const response = await request(
    `${apiUrl.replace(/\/+$/, "")}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${createAppJwt(appId, privateKey)}`,
        "User-Agent": "github-app-token",
        "X-GitHub-Api-Version": "2022-11-28",
      },
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
  return body.token;
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
  } else if (process.argv.length !== 2) {
    process.stderr.write("Usage: github-app-token\n");
    process.exitCode = 2;
  } else {
    try {
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
      const token = await mintInstallationToken({
        apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
        appId,
        installationId,
        privateKey,
      });
      process.stdout.write(`${token}\n`);
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = error instanceof ConfigurationError ? 2 : 1;
    }
  }
}
