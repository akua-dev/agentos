import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiscordIngress } from "../src/main.ts";
import type { DiscordExternalEventSink } from "../src/events.ts";

describe("discord-ingress executable", () => {
  test("describes message and interaction ingress without opening connections", async () => {
    const lines: string[] = [];
    const exitCode = await runDiscordIngress(["--help"], {
      environment: {},
      fetchImpl: async () => {
        throw new Error("must not connect");
      },
      writeLine: (line) => lines.push(line),
      writeError: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(lines.join("\n")).toContain(
      "Persist approved Discord Gateway messages and interactions",
    );
  });

  test("fails closed before opening provider or database connections when configuration is incomplete", async () => {
    let gatewayStarts = 0;
    let sinkStarts = 0;
    const errors: string[] = [];

    const exitCode = await runDiscordIngress([], {
      environment: {},
      writeLine: () => undefined,
      writeError: (line) => errors.push(line),
      createSink: async () => {
        sinkStarts += 1;
        throw new Error("must not connect");
      },
      runGateway: async () => {
        gatewayStarts += 1;
      },
    });

    expect(exitCode).toBe(2);
    expect({ gatewayStarts, sinkStarts }).toEqual({
      gatewayStarts: 0,
      sinkStarts: 0,
    });
    expect(errors.join("\n")).toContain("DISCORD_BOT_TOKEN_FILE");
    expect(errors.join("\n")).not.toContain("must not connect");
  });

  test("seeds guild channels and passes approved events from Gateway to the sink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "discord-ingress-main-"));
    const tokenFile = join(directory, "token");
    await writeFile(tokenFile, "bot-secret\n", { mode: 0o600 });
    const ingested: unknown[] = [];
    let closed = false;
    const sink: DiscordExternalEventSink & { close(): Promise<void> } = {
      async ingest(event) {
        ingested.push(event);
      },
      async close() {
        closed = true;
      },
    };
    const requests: string[] = [];

    try {
      const exitCode = await runDiscordIngress([], {
        environment: {
          DATABASE_URL: "postgresql://fleet-owner@postgres/agentos",
          DISCORD_BOT_TOKEN_FILE: tokenFile,
          DISCORD_GUILD_ID: "100",
          DISCORD_MANAGED_CATEGORY_IDS: "200, 201",
        },
        apiBaseUrl: "https://discord.test/api/v10",
        fetchImpl: async (input, init) => {
          const request = new Request(String(input), init);
          expect(request.headers.get("authorization")).toBe("Bot bot-secret");
          requests.push(request.url);
          if (request.url.endsWith("/guilds/100/channels")) {
            return Response.json([
              { id: "200", type: 4, parent_id: null },
              { id: "300", type: 0, parent_id: "200" },
            ]);
          }
          return new Response("not found", { status: 404 });
        },
        createSink: async () => sink,
        async runGateway(options) {
          expect(options.token).toBe("bot-secret");
          await options.onDispatch({
            op: 0,
            t: "READY",
            s: 1,
            d: { user: { id: "400" } },
          });
          await options.onDispatch({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 2,
            d: {
              id: "500",
              guild_id: "100",
              channel_id: "300",
              author: { id: "600" },
              content: "Team intent",
              mentions: [],
            },
          });
        },
        writeLine: () => undefined,
        writeError: () => undefined,
      });

      expect(exitCode).toBe(0);
      expect(requests).toEqual([
        "https://discord.test/api/v10/guilds/100/channels",
      ]);
      expect(ingested).toHaveLength(1);
      expect(closed).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("persists a component before acknowledging it without bot authorization", async () => {
    const order: string[] = [];
    const ingested: unknown[] = [];
    const errors: string[] = [];

    const exitCode = await runDiscordIngress([], {
      environment: {
        DATABASE_URL: "postgresql://owner@postgres/agentos",
        DISCORD_BOT_TOKEN: "bot-secret",
        DISCORD_GUILD_ID: "100",
        DISCORD_MANAGED_CATEGORY_IDS: "200",
      },
      apiBaseUrl: "https://discord.test/api/v10",
      fetchImpl: async (input, init) => {
        const request = new Request(String(input), init);
        if (request.url.endsWith("/guilds/100/channels")) {
          expect(request.headers.get("authorization")).toBe("Bot bot-secret");
          return Response.json([
            { id: "200", type: 4, parent_id: null },
            { id: "300", type: 0, parent_id: "200" },
          ]);
        }
        expect(request.url).toBe(
          "https://discord.test/api/v10/interactions/700/interaction-secret/callback",
        );
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBeNull();
        expect(await request.json()).toEqual({ type: 6 });
        order.push("acknowledge");
        return new Response(null, { status: 204 });
      },
      createSink: async () => ({
        async ingest(event) {
          ingested.push(event);
          order.push("ingest");
        },
        async close() {},
      }),
      async runGateway(options) {
        await options.onDispatch({
          op: 0,
          t: "READY",
          s: 1,
          d: { user: { id: "400" } },
        });
        await options.onDispatch({
          op: 0,
          t: "INTERACTION_CREATE",
          s: 2,
          d: {
            id: "700",
            token: "interaction-secret",
            type: 3,
            guild_id: "100",
            channel_id: "300",
            member: { user: { id: "600" } },
            data: {
              component_type: 2,
              custom_id: "agentos:follow-up:decision:release-42",
            },
          },
        });
      },
      writeLine: () => undefined,
      writeError: (line) => errors.push(line),
    });

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(order).toEqual(["ingest", "acknowledge"]);
    expect(JSON.stringify(ingested)).not.toContain("interaction-secret");
    expect(JSON.stringify(ingested)).toContain("[REDACTED]");
  });

  test("reports interaction acknowledgement failure without its temporary token", async () => {
    const errors: string[] = [];
    const exitCode = await runDiscordIngress([], {
      environment: {
        DATABASE_URL: "postgresql://owner@postgres/agentos",
        DISCORD_BOT_TOKEN: "bot-secret",
        DISCORD_GUILD_ID: "100",
        DISCORD_MANAGED_CATEGORY_IDS: "200",
      },
      apiBaseUrl: "https://discord.test/api/v10",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/guilds/100/channels")) {
          return Response.json([
            { id: "200", type: 4, parent_id: null },
            { id: "300", type: 0, parent_id: "200" },
          ]);
        }
        return new Response("expired", { status: 401 });
      },
      createSink: async () => ({
        async ingest() {},
        async close() {},
      }),
      async runGateway(options) {
        await options.onDispatch({
          op: 0,
          t: "READY",
          s: 1,
          d: { user: { id: "400" } },
        });
        await options.onDispatch({
          op: 0,
          t: "INTERACTION_CREATE",
          s: 2,
          d: {
            id: "700",
            token: "interaction-secret",
            type: 3,
            guild_id: "100",
            channel_id: "300",
            member: { user: { id: "600" } },
            data: {
              component_type: 2,
              custom_id: "agentos:stop:decision:release-42",
            },
          },
        });
      },
      writeLine: () => undefined,
      writeError: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain(
      "Discord interaction acknowledgement returned HTTP 401",
    );
    expect(errors.join("\n")).not.toContain("interaction-secret");
    expect(errors.join("\n")).not.toContain("bot-secret");
  });

  test("returns provider or persistence failures without printing token values", async () => {
    const errors: string[] = [];
    const exitCode = await runDiscordIngress([], {
      environment: {
        DATABASE_URL: "postgresql://owner@postgres/agentos",
        DISCORD_BOT_TOKEN: "bot-secret",
        DISCORD_GUILD_ID: "100",
        DISCORD_MANAGED_CATEGORY_IDS: "200",
      },
      fetchImpl: async () => Response.json([]),
      createSink: async () => ({
        async ingest() {},
        async close() {},
      }),
      runGateway: async () => {
        throw new Error("Discord rejected bot-secret while connecting");
      },
      writeLine: () => undefined,
      writeError: (line) => errors.push(line),
    });

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Discord rejected [REDACTED]");
    expect(errors.join("\n")).not.toContain("bot-secret");
  });
});
