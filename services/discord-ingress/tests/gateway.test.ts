import { describe, expect, test } from "bun:test";
import { runDiscordGateway } from "../src/gateway.ts";
import type { DiscordGatewayDispatch } from "../src/events.ts";

describe("Discord Gateway lifecycle", () => {
  test("identifies with minimal intents, heartbeats and forwards raw dispatches", async () => {
    const controller = new AbortController();
    const dispatches: DiscordGatewayDispatch[] = [];
    const clientPayloads: Array<Record<string, unknown>> = [];
    let apiAuthorization: string | null = null;
    let sentDispatches = false;
    let server!: ReturnType<typeof Bun.serve>;

    server = Bun.serve<{ connected: boolean }>({
      port: 0,
      fetch(request, bunServer) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v10/gateway/bot") {
          apiAuthorization = request.headers.get("authorization");
          return Response.json({
            url: server.url.toString().replace(/^http/, "ws") + "gateway",
          });
        }
        if (url.pathname === "/gateway") {
          expect(url.searchParams.get("v")).toBe("10");
          expect(url.searchParams.get("encoding")).toBe("json");
          if (bunServer.upgrade(request, { data: { connected: true } })) {
            return undefined;
          }
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(socket) {
          socket.send(
            JSON.stringify({ op: 10, d: { heartbeat_interval: 10 } }),
          );
        },
        message(socket, rawMessage) {
          const payload = JSON.parse(String(rawMessage)) as Record<
            string,
            unknown
          >;
          clientPayloads.push(payload);
          if (payload.op === 1) {
            socket.send(JSON.stringify({ op: 11, d: null }));
          }
          if (
            !sentDispatches &&
            clientPayloads.some(({ op }) => op === 1) &&
            clientPayloads.some(({ op }) => op === 2)
          ) {
            sentDispatches = true;
            socket.send(
              JSON.stringify({
                op: 0,
                t: "READY",
                s: 1,
                d: {
                  session_id: "session-1",
                  resume_gateway_url:
                    server.url.toString().replace(/^http/, "ws") + "gateway",
                  user: { id: "bot-1" },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                op: 0,
                t: "MESSAGE_CREATE",
                s: 2,
                d: { id: "message-1", channel_id: "channel-1" },
              }),
            );
          }
        },
      },
    });

    try {
      await runDiscordGateway({
        token: "bot-secret",
        apiBaseUrl: new URL("/api/v10", server.url).toString(),
        random: () => 0,
        signal: controller.signal,
        async onDispatch(dispatch) {
          dispatches.push(dispatch);
          if (dispatch.t === "MESSAGE_CREATE") controller.abort();
        },
      });

      expect(apiAuthorization as string | null).toBe("Bot bot-secret");
      expect(clientPayloads).toContainEqual({
        op: 2,
        d: {
          token: "bot-secret",
          intents: 37_377,
          properties: {
            os: process.platform,
            browser: "agentos-discord-ingress",
            device: "agentos-discord-ingress",
          },
        },
      });
      expect(clientPayloads.some(({ op }) => op === 1)).toBe(true);
      expect(dispatches.map(({ t, s }) => ({ t, s }))).toEqual([
        { t: "READY", s: 1 },
        { t: "MESSAGE_CREATE", s: 2 },
      ]);
    } finally {
      controller.abort();
      server.stop(true);
    }
  });
});
