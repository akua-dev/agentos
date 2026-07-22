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

  for (const closeCode of [1_001, 4_007, 4_009]) {
    test(`starts a fresh session after close code ${closeCode}`, async () => {
      const controller = new AbortController();
      let connectionCount = 0;
      let identifyCount = 0;
      let resumeCount = 0;
      let server!: ReturnType<typeof Bun.serve>;

      server = Bun.serve<{ connection: number }>({
        port: 0,
        fetch(request, bunServer) {
          const url = new URL(request.url);
          if (url.pathname === "/api/v10/gateway/bot") {
            return Response.json({
              url: server.url.toString().replace(/^http/, "ws") + "gateway",
            });
          }
          if (url.pathname === "/gateway") {
            if (
              bunServer.upgrade(request, {
                data: { connection: ++connectionCount },
              })
            ) {
              return undefined;
            }
          }
          return new Response("not found", { status: 404 });
        },
        websocket: {
          open(socket) {
            socket.send(
              JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }),
            );
          },
          message(socket, rawMessage) {
            const payload = JSON.parse(String(rawMessage)) as {
              op?: number;
            };
            if (payload.op === 2) {
              identifyCount += 1;
              if (socket.data.connection === 1) {
                socket.send(
                  JSON.stringify({
                    op: 0,
                    t: "READY",
                    s: 1,
                    d: {
                      session_id: "session-1",
                      resume_gateway_url:
                        server.url.toString().replace(/^http/, "ws") +
                        "gateway",
                    },
                  }),
                );
                setTimeout(() => socket.close(closeCode, "test"), 0);
              } else {
                controller.abort();
              }
            }
            if (payload.op === 6) {
              resumeCount += 1;
              controller.abort();
            }
          },
        },
      });

      try {
        await runDiscordGateway({
          token: "bot-secret",
          apiBaseUrl: new URL("/api/v10", server.url).toString(),
          signal: controller.signal,
          onDispatch: async () => undefined,
        });

        expect(identifyCount).toBe(2);
        expect(resumeCount).toBe(0);
      } finally {
        controller.abort();
        server.stop(true);
      }
    });
  }

  test("lets a fatal close remain authoritative when error races close", async () => {
    const controller = new AbortController();
    const nativeWebSocket = globalThis.WebSocket;
    let instances = 0;

    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readonly url: string;
      readyState = FakeWebSocket.OPEN;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        instances += 1;
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                op: 10,
                d: { heartbeat_interval: 100 },
              }),
            }),
          );
          if (instances > 1) controller.abort();
        });
      }

      send(value: string): void {
        const payload = JSON.parse(value) as { op?: number };
        if (payload.op !== 2) return;
        queueMicrotask(() => this.dispatchEvent(new Event("error")));
        queueMicrotask(() =>
          this.dispatchEvent(
            new CloseEvent("close", { code: 4_004, reason: "fatal" }),
          ),
        );
      }

      close(): void {
        this.readyState = 3;
      }
    }

    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: FakeWebSocket,
    });

    try {
      await expect(
        runDiscordGateway({
          token: "bot-secret",
          fetchImpl: async () =>
            Response.json({ url: "ws://discord.test/gateway" }),
          signal: controller.signal,
          onDispatch: async () => undefined,
        }),
      ).rejects.toThrow("4004");
      expect(instances).toBe(1);
    } finally {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: nativeWebSocket,
      });
      controller.abort();
    }
  });

  test("drains an accepted dispatch before resuming after a close", async () => {
    const controller = new AbortController();
    let startPersistence!: () => void;
    let releasePersistence!: () => void;
    let markCloseSent!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
      startPersistence = resolve;
    });
    const persistenceReleased = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const closeSent = new Promise<void>((resolve) => {
      markCloseSent = resolve;
    });
    let resumePayload: Record<string, unknown> | undefined;
    let server!: ReturnType<typeof Bun.serve>;

    server = Bun.serve<{ connection: number }>({
      port: 0,
      fetch(request, bunServer) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v10/gateway/bot") {
          return Response.json({
            url: server.url.toString().replace(/^http/, "ws") + "gateway",
          });
        }
        if (url.pathname === "/gateway") {
          if (
            bunServer.upgrade(request, {
              data: { connection: 1 },
            })
          ) {
            return undefined;
          }
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(socket) {
          socket.send(
            JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }),
          );
        },
        message(socket, rawMessage) {
          const payload = JSON.parse(String(rawMessage)) as Record<
            string,
            unknown
          >;
          if (payload.op === 2) {
            socket.send(
              JSON.stringify({
                op: 0,
                t: "READY",
                s: 1,
                d: {
                  session_id: "session-1",
                  resume_gateway_url:
                    server.url.toString().replace(/^http/, "ws") + "gateway",
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
            setTimeout(() => {
              markCloseSent();
              socket.close(4_000, "test");
            }, 0);
          }
          if (payload.op === 6) {
            resumePayload = payload;
            controller.abort();
          }
        },
      },
    });

    const runPromise = runDiscordGateway({
      token: "bot-secret",
      apiBaseUrl: new URL("/api/v10", server.url).toString(),
      signal: controller.signal,
      async onDispatch(dispatch) {
        if (dispatch.t === "MESSAGE_CREATE") {
          startPersistence();
          await persistenceReleased;
        }
      },
    });

    try {
      await persistenceStarted;
      await closeSent;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(resumePayload).toBeUndefined();
      releasePersistence();
      await runPromise;
      expect(resumePayload).toEqual({
        op: 6,
        d: {
          token: "bot-secret",
          session_id: "session-1",
          seq: 2,
        },
      });
    } finally {
      controller.abort();
      server.stop(true);
    }
  });

  test("fails instead of resuming after accepted dispatch persistence fails", async () => {
    const controller = new AbortController();
    let startPersistence!: () => void;
    let releasePersistence!: () => void;
    let markCloseSent!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => {
      startPersistence = resolve;
    });
    const persistenceReleased = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const closeSent = new Promise<void>((resolve) => {
      markCloseSent = resolve;
    });
    let resumeCount = 0;
    let server!: ReturnType<typeof Bun.serve>;

    server = Bun.serve<{ connection: number }>({
      port: 0,
      fetch(request, bunServer) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v10/gateway/bot") {
          return Response.json({
            url: server.url.toString().replace(/^http/, "ws") + "gateway",
          });
        }
        if (url.pathname === "/gateway") {
          if (
            bunServer.upgrade(request, {
              data: { connection: 1 },
            })
          ) {
            return undefined;
          }
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(socket) {
          socket.send(
            JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }),
          );
        },
        message(socket, rawMessage) {
          const payload = JSON.parse(String(rawMessage)) as Record<
            string,
            unknown
          >;
          if (payload.op === 2) {
            socket.send(
              JSON.stringify({
                op: 0,
                t: "READY",
                s: 1,
                d: {
                  session_id: "session-1",
                  resume_gateway_url:
                    server.url.toString().replace(/^http/, "ws") + "gateway",
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
            setTimeout(() => {
              markCloseSent();
              socket.close(4_000, "test");
            }, 0);
          }
          if (payload.op === 6) {
            resumeCount += 1;
            controller.abort();
          }
        },
      },
    });

    const runPromise = runDiscordGateway({
      token: "bot-secret",
      apiBaseUrl: new URL("/api/v10", server.url).toString(),
      signal: controller.signal,
      async onDispatch(dispatch) {
        if (dispatch.t === "MESSAGE_CREATE") {
          startPersistence();
          await persistenceReleased;
          throw new Error("persistence failed");
        }
      },
    });

    try {
      await persistenceStarted;
      await closeSent;
      await new Promise((resolve) => setTimeout(resolve, 300));
      releasePersistence();
      await expect(runPromise).rejects.toThrow("persistence failed");
      expect(resumeCount).toBe(0);
    } finally {
      controller.abort();
      server.stop(true);
    }
  });
});
