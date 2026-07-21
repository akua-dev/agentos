import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../github-app-token.ts");
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

describe("github-app-token", () => {
  test("exposes a real help surface without credentials", async () => {
    const child = Bun.spawn([process.execPath, cli, "--help"], {
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("github-app-token");
    expect(stdout).toContain("GITHUB_APP_PRIVATE_KEY_FILE");
  });

  test("fails before network access when required configuration is absent", async () => {
    const child = Bun.spawn([process.execPath, cli], {
      env: {},
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("GITHUB_APP_ID");
  });

  test("mints one installation token through the GitHub App endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "github-app-token-"));
    const keyFile = join(directory, "private-key.pem");
    await writeFile(keyFile, privateKey, { mode: 0o600 });

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(request.method).toBe("POST");
        expect(new URL(request.url).pathname).toBe(
          "/app/installations/148117737/access_tokens",
        );
        expect(await request.text()).toBe("");
        const authorization = request.headers.get("authorization");
        expect(authorization).toStartWith("Bearer ");
        const jwt = authorization!.slice("Bearer ".length);
        const [, payload] = jwt.split(".");
        if (!payload) throw new Error("JWT payload is missing");
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        expect(claims.iss).toBe("4359249");
        expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
        return Response.json({
          token: "installation-token",
          expires_at: "2026-07-21T22:00:00Z",
        });
      },
    });

    try {
      const child = Bun.spawn([process.execPath, cli], {
        env: {
          GITHUB_API_URL: server.url.toString(),
          GITHUB_APP_ID: "4359249",
          GITHUB_APP_INSTALLATION_ID: "148117737",
          GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toBe("installation-token\n");
    } finally {
      server.stop(true);
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("requests reduced scope and writes an atomic token plus non-secret metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "github-app-token-scope-"));
    const keyFile = join(directory, "private-key.pem");
    const scopeFile = join(directory, "scope.json");
    const tokenFile = join(directory, "token");
    const metadataFile = join(directory, "metadata.json");
    await writeFile(keyFile, privateKey, { mode: 0o600 });
    await writeFile(
      scopeFile,
      JSON.stringify({
        repositories: ["agentos"],
        permissions: {
          contents: "write",
          pull_requests: "write",
        },
      }),
      { mode: 0o600 },
    );

    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(request.headers.get("content-type")).toBe("application/json");
        expect(await request.json()).toEqual({
          repositories: ["agentos"],
          permissions: {
            contents: "write",
            pull_requests: "write",
          },
        });
        return Response.json({
          token: "scoped-installation-token",
          expires_at: "2026-07-21T22:00:00Z",
          permissions: {
            contents: "write",
            pull_requests: "write",
          },
          repository_selection: "selected",
          repositories: [
            { id: 123, full_name: "akua-dev/agentos", ignored: "provider data" },
          ],
        });
      },
    });

    try {
      const child = Bun.spawn(
        [
          process.execPath,
          cli,
          "--scope-file",
          scopeFile,
          "--token-file",
          tokenFile,
          "--metadata-file",
          metadataFile,
        ],
        {
          env: {
            GITHUB_API_URL: server.url.toString(),
            GITHUB_APP_ID: "4359249",
            GITHUB_APP_INSTALLATION_ID: "148117737",
            GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(await readFile(tokenFile, "utf8")).toBe(
        "scoped-installation-token\n",
      );
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
      expect((await stat(metadataFile)).mode & 0o777).toBe(0o600);
      const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
      expect(metadata).toEqual({
        expires_at: "2026-07-21T22:00:00Z",
        permissions: {
          contents: "write",
          pull_requests: "write",
        },
        repository_selection: "selected",
        repositories: [{ id: 123, full_name: "akua-dev/agentos" }],
      });
      expect(JSON.stringify(metadata)).not.toContain("scoped-installation-token");
    } finally {
      server.stop(true);
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects ambiguous repository scope before contacting GitHub", async () => {
    const directory = await mkdtemp(join(tmpdir(), "github-app-token-invalid-"));
    const keyFile = join(directory, "private-key.pem");
    const scopeFile = join(directory, "scope.json");
    await writeFile(keyFile, privateKey, { mode: 0o600 });
    await writeFile(
      scopeFile,
      JSON.stringify({ repositories: ["agentos"], repository_ids: [123] }),
      { mode: 0o600 },
    );
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1;
        return Response.json({ token: "must-not-be-minted" });
      },
    });

    try {
      const child = Bun.spawn(
        [process.execPath, cli, "--scope-file", scopeFile],
        {
          env: {
            GITHUB_API_URL: server.url.toString(),
            GITHUB_APP_ID: "4359249",
            GITHUB_APP_INSTALLATION_ID: "148117737",
            GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain(
        "scope must use repositories or repository_ids, not both",
      );
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("reports provider failure without echoing response secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "github-app-token-error-"));
    const keyFile = join(directory, "private-key.pem");
    await writeFile(keyFile, privateKey, { mode: 0o600 });
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { message: "installation access denied", token: "must-not-leak" },
          { status: 403 },
        ),
    });

    try {
      const child = Bun.spawn([process.execPath, cli], {
        env: {
          GITHUB_API_URL: server.url.toString(),
          GITHUB_APP_ID: "4359249",
          GITHUB_APP_INSTALLATION_ID: "148117737",
          GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("403: installation access denied");
      expect(stderr).not.toContain("must-not-leak");
    } finally {
      server.stop(true);
      await rm(directory, { force: true, recursive: true });
    }
  });
});
