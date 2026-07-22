import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import { runDiscordCli } from "../discord.ts";

const cli = resolve(import.meta.dir, "../discord.ts");

async function run(args: string[], environment: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("discord", () => {
  test("exposes the raw request contract without credentials", async () => {
    const result = await run(["--help"]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: expect.stringContaining(
        "discord request <METHOD> </relative/api/path>",
      ),
    });
  });

  test("fails before network access when no bot credential is configured", async () => {
    const result = await run(["request", "GET", "/users/@me"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("DISCORD_BOT_TOKEN_FILE");
  });

  test("reports an unreadable token file as structured configuration failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-discord-cli-"));
    const output: string[] = [];
    const errors: string[] = [];

    try {
      const exitCode = await runDiscordCli(
        ["request", "GET", "/users/@me", "--axi"],
        {
          environment: { DISCORD_BOT_TOKEN_FILE: join(directory, "missing") },
          write: (text) => output.push(text),
          writeError: (text) => errors.push(text),
        },
      );

      expect(exitCode).toBe(2);
      expect(errors).toEqual([]);
      expect(output.join("")).toContain("code: discord_configuration");
      expect(output.join("")).toContain("DISCORD_BOT_TOKEN_FILE");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("classifies an empty token file as configuration failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-discord-cli-"));
    const tokenFile = join(directory, "token");
    const output: string[] = [];
    const errors: string[] = [];

    try {
      await writeFile(tokenFile, "\n", { mode: 0o600 });
      const exitCode = await runDiscordCli(
        ["request", "GET", "/users/@me", "--axi"],
        {
          environment: { DISCORD_BOT_TOKEN_FILE: tokenFile },
          write: (text) => output.push(text),
          writeError: (text) => errors.push(text),
        },
      );

      expect(exitCode).toBe(2);
      expect(errors).toEqual([]);
      expect(output.join("")).toContain("code: discord_configuration");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("reads the bot token from a file and sends a stdin body to a relative API path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-discord-cli-"));
    const tokenFile = join(directory, "token");
    await writeFile(tokenFile, "bot-secret\n", { mode: 0o600 });
    const output: string[] = [];
    const errors: string[] = [];
    let observed: Request | undefined;

    try {
      const exitCode = await runDiscordCli(
        ["request", "POST", "/channels/123/messages"],
        {
          environment: {
            DISCORD_BOT_TOKEN: "ignored-environment-secret",
            DISCORD_BOT_TOKEN_FILE: tokenFile,
          },
          apiBaseUrl: "https://discord.test/api/v10",
          readStdin: async () => '{"content":"hello"}',
          fetchImpl: async (input, init) => {
            observed = new Request(String(input), init);
            return new Response('{"id":"456"}', {
              headers: { "content-type": "application/json" },
              status: 200,
            });
          },
          write: (text) => output.push(text),
          writeError: (text) => errors.push(text),
        },
      );

      expect(exitCode).toBe(0);
      expect(observed?.url).toBe(
        "https://discord.test/api/v10/channels/123/messages",
      );
      expect(observed?.method).toBe("POST");
      expect(observed?.headers.get("authorization")).toBe("Bot bot-secret");
      expect(observed?.headers.get("content-type")).toBe("application/json");
      expect(await observed?.text()).toBe('{"content":"hello"}');
      expect(output).toEqual(['{"id":"456"}']);
      expect(errors).toEqual([]);
      expect(output.join("") + errors.join("")).not.toContain("bot-secret");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("emits a compact AXI receipt for a Discord message mutation", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runDiscordCli(
      ["request", "POST", "/channels/123/messages", "--axi"],
      {
        environment: { DISCORD_BOT_TOKEN: "bot-secret" },
        readStdin: async () => '{"content":"Captain-only input"}',
        fetchImpl: async () =>
          Response.json({
            id: "456",
            channel_id: "123",
            content: "Captain-only input",
            timestamp: "2026-07-22T20:00:00.000000+00:00",
            embeds: [{ title: "Decision" }],
            components: [{ type: 1 }],
          }),
        write: (text) => output.push(text),
        writeError: (text) => errors.push(text),
      },
    );

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(output.join("")).toContain("message:");
    expect(output.join("")).toContain('id: "456"');
    expect(output.join("")).toContain("embed_count: 1");
    expect(output.join("")).toContain("component_count: 1");
    expect(output.join("")).not.toContain("Captain-only input");
  });

  test("preserves the complete provider response with AXI full output", async () => {
    const output: string[] = [];

    const exitCode = await runDiscordCli(
      ["request", "POST", "/channels/123/messages", "--axi", "--full"],
      {
        environment: { DISCORD_BOT_TOKEN: "bot-secret" },
        readStdin: async () => '{"content":"Complete response"}',
        fetchImpl: async () =>
          Response.json({
            id: "456",
            channel_id: "123",
            content: "Complete response",
            author: { id: "789", username: "firstmate" },
          }),
        write: (text) => output.push(text),
        writeError: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(output.join("")).toContain("content: Complete response");
    expect(output.join("")).toContain("username: firstmate");
  });

  test("bounds and projects Discord message collections in AXI mode", async () => {
    const output: string[] = [];
    const messages = Array.from({ length: 22 }, (_, index) => ({
      id: String(index + 1),
      channel_id: "123",
      author: { id: `author-${index}`, username: `mate-${index}` },
      content: `message-${index}`,
      timestamp: `2026-07-22T20:00:${String(index).padStart(2, "0")}.000Z`,
      nonce: `not-useful-${index}`,
    }));

    const exitCode = await runDiscordCli(
      ["request", "GET", "/channels/123/messages?limit=100", "--axi"],
      {
        environment: { DISCORD_BOT_TOKEN: "bot-secret" },
        fetchImpl: async () => Response.json(messages),
        write: (text) => output.push(text),
        writeError: () => undefined,
      },
    );

    const result = output.join("");
    expect(exitCode).toBe(0);
    expect(result).toContain("returned_count: 20");
    expect(result).toContain("omitted_count: 2");
    expect(result).toContain("message-19");
    expect(result).not.toContain("message-20");
    expect(result).not.toContain("not-useful");
  });

  test("preserves mixed message-path arrays losslessly in AXI mode", async () => {
    const output: string[] = [];

    const exitCode = await runDiscordCli(
      ["request", "GET", "/channels/123/messages?limit=2", "--axi"],
      {
        environment: { DISCORD_BOT_TOKEN: "bot-secret" },
        fetchImpl: async () =>
          Response.json([
            { id: "1", channel_id: "123", content: "known" },
            { kind: "unknown", content: "retained" },
          ]),
        write: (text) => output.push(text),
        writeError: () => undefined,
      },
    );

    const result = output.join("");
    expect(exitCode).toBe(0);
    expect(result).toContain("retained");
    expect(result).not.toContain("summary:");
  });

  test("does not classify an empty non-message array in AXI mode", async () => {
    const output: string[] = [];

    const exitCode = await runDiscordCli(
      ["request", "GET", "/users/@me", "--axi"],
      {
        environment: { DISCORD_BOT_TOKEN: "bot-secret" },
        fetchImpl: async () => Response.json([]),
        write: (text) => output.push(text),
        writeError: () => undefined,
      },
    );

    const result = output.join("");
    expect(exitCode).toBe(0);
    expect(result).not.toContain("summary:");
    expect(result).not.toContain("empty: true");
  });

  test("projects one Discord message read to a content-first AXI view", async () => {
    const output: string[] = [];

    const exitCode = await runDiscordCli(
      ["request", "GET", "/channels/123/messages/456", "--axi"],
      {
        environment: { DISCORD_BOT_TOKEN: "bot-secret" },
        fetchImpl: async () =>
          Response.json({
            id: "456",
            channel_id: "123",
            author: { id: "789", username: "captain" },
            timestamp: "2026-07-22T20:00:00.000Z",
            content: "Ship it",
            nonce: "not-useful",
          }),
        write: (text) => output.push(text),
        writeError: () => undefined,
      },
    );

    const result = output.join("");
    expect(exitCode).toBe(0);
    expect(result).toContain("message:");
    expect(result).toContain("author: captain");
    expect(result).toContain("content: Ship it");
    expect(result).not.toContain("nonce");
  });

  test("emits a definitive empty state for an empty Discord message read", async () => {
    const output: string[] = [];

    const exitCode = await runDiscordCli(
      ["request", "GET", "/channels/123/messages?limit=20", "--axi"],
      {
        environment: { DISCORD_BOT_TOKEN: "bot-secret" },
        fetchImpl: async () => Response.json([]),
        write: (text) => output.push(text),
        writeError: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(output.join("")).toContain("empty: true");
    expect(output.join("")).toContain("returned_count: 0");
  });

  test("emits a definitive success for an empty provider response", async () => {
    const output: string[] = [];

    const exitCode = await runDiscordCli(
      ["request", "DELETE", "/channels/123/messages/456", "--axi"],
      {
        environment: { DISCORD_BOT_TOKEN: "bot-secret" },
        readStdin: async () => "",
        fetchImpl: async () => new Response(null, { status: 204 }),
        write: (text) => output.push(text),
        writeError: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    expect(output.join("")).toContain("ok: true");
    expect(output.join("")).toContain("empty: true");
  });

  test("rejects an absolute provider URL before reading credentials or making a request", async () => {
    let requests = 0;
    const errors: string[] = [];

    const exitCode = await runDiscordCli(
      ["request", "GET", "https://attacker.test/collect"],
      {
        environment: { DISCORD_BOT_TOKEN: "bot-secret" },
        fetchImpl: async () => {
          requests += 1;
          return new Response();
        },
        write: () => undefined,
        writeError: (text) => errors.push(text),
      },
    );

    expect(exitCode).toBe(2);
    expect(requests).toBe(0);
    expect(errors.join("\n")).toContain("relative Discord API path");
  });

  test("returns the real non-success body and a failing exit status without retry", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    let requests = 0;
    const providerBody =
      '{"message":"You are being rate limited.","retry_after":1.25}';

    const exitCode = await runDiscordCli(
      ["request", "GET", "/channels/123/messages?limit=1"],
      {
        environment: { DISCORD_BOT_TOKEN: "bot-secret" },
        fetchImpl: async () => {
          requests += 1;
          return new Response(providerBody, { status: 429 });
        },
        readStdin: async () => "",
        write: (text) => output.push(text),
        writeError: (text) => errors.push(text),
      },
    );

    expect(exitCode).toBe(1);
    expect(requests).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual([providerBody]);
    expect(errors.join("")).not.toContain("bot-secret");
  });

  test("emits a structured Discord error on stdout in AXI mode", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runDiscordCli(
      ["request", "GET", "/channels/123/messages", "--axi"],
      {
        environment: { DISCORD_BOT_TOKEN: "bot-secret" },
        fetchImpl: async () =>
          Response.json(
            { message: "You are being rate limited.", retry_after: 1.25 },
            { status: 429 },
          ),
        write: (text) => output.push(text),
        writeError: (text) => errors.push(text),
      },
    );

    const result = output.join("");
    expect(exitCode).toBe(1);
    expect(errors).toEqual([]);
    expect(result).toContain("code: discord_http_429");
    expect(result).toContain("status: 429");
    expect(result).toContain("message: You are being rate limited.");
    expect(result).toContain("retry_after: 1.25");
  });

  test("emits structured local failures in AXI mode", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runDiscordCli(
      ["request", "GET", "/users/@me", "--axi"],
      {
        environment: {},
        write: (text) => output.push(text),
        writeError: (text) => errors.push(text),
      },
    );

    expect(exitCode).toBe(2);
    expect(errors).toEqual([]);
    expect(output.join("")).toContain("code: discord_configuration");
    expect(output.join("")).toContain("DISCORD_BOT_TOKEN_FILE");
  });

  test("reports invalid AXI invocations as structured usage errors", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runDiscordCli(
      ["request", "GET", "/users/@me", "--axi", "--unknown"],
      {
        environment: {},
        write: (text) => output.push(text),
        writeError: (text) => errors.push(text),
      },
    );

    expect(exitCode).toBe(2);
    expect(errors).toEqual([]);
    expect(output.join("")).toContain("code: discord_usage");
    expect(output.join("")).toContain("discord request");
  });

  test("explains how to recover when a provider response cannot become AXI output", async () => {
    const output: string[] = [];
    const errors: string[] = [];

    const exitCode = await runDiscordCli(
      ["request", "GET", "/gateway", "--axi"],
      {
        environment: { DISCORD_BOT_TOKEN: "bot-secret" },
        fetchImpl: async () => new Response("not-json", { status: 200 }),
        write: (text) => output.push(text),
        writeError: (text) => errors.push(text),
      },
    );

    expect(exitCode).toBe(1);
    expect(errors).toEqual([]);
    expect(output.join("")).toContain("code: discord_axi_output");
    expect(output.join("")).toContain("Retry without --axi");
  });

  test("treats a network failure as runtime failure and redacts a file-sourced token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-discord-cli-"));
    const tokenFile = join(directory, "token");
    await writeFile(tokenFile, "file-bot-secret\n", { mode: 0o600 });
    const errors: string[] = [];

    try {
      const exitCode = await runDiscordCli(
        ["request", "GET", "/users/@me"],
        {
          environment: { DISCORD_BOT_TOKEN_FILE: tokenFile },
          fetchImpl: async () => {
            throw new TypeError("network rejected file-bot-secret");
          },
          write: () => undefined,
          writeError: (text) => errors.push(text),
        },
      );

      expect(exitCode).toBe(1);
      expect(errors.join("")).toContain("network rejected [REDACTED]");
      expect(errors.join("")).not.toContain("file-bot-secret");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
