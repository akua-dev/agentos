import { describe, expect, test } from "bun:test";
import { createProxyHandler } from "../src/proxy.ts";
import type {
  GatewayRequestOutcome,
  GatewayTelemetry,
} from "../src/telemetry.ts";
import type { RouteLease } from "../src/types.ts";

function request(path = "/responses", token = "fleet-token", signal?: AbortSignal) {
  return new Request(`http://gateway.test${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "chatgpt-account-id": "inbound-must-not-survive",
      "session-id": "session-a",
    },
    body: JSON.stringify({ model: "gpt-test", input: "hello" }),
    signal,
  });
}

describe("authenticated raw Responses proxy", () => {
  test("reports the complete streamed lifecycle and strips AgentOS correlation headers upstream", async () => {
    const events: unknown[] = [];
    let upstream: Request | undefined;
    const telemetry = recordingTelemetry(events);
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      telemetry,
      acquire: async () => ({
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: "api-secret",
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => undefined,
      }),
      fetchImpl: async (input, init) => {
        upstream = new Request(
          input instanceof Request ? input.url : input.toString(),
          init,
        );
        return new Response("stream-body", { status: 200 });
      },
    });
    const gatewayRequest = request();
    gatewayRequest.headers.set("x-agentos-runtime", "pi");
    gatewayRequest.headers.set("x-agentos-request-kind", "main");
    gatewayRequest.headers.set("x-agentos-model-family", "gpt-5");
    gatewayRequest.headers.set("x-agentos-stream-mode", "streaming");
    gatewayRequest.headers.set(
      "x-agentos-request-attempt-id",
      "pi-attempt-private",
    );

    const response = await handler(gatewayRequest);
    expect(await response.text()).toBe("stream-body");
    expect(
      [...(upstream?.headers.keys() ?? [])].filter((name) =>
        name.startsWith("x-agentos-"),
      ),
    ).toEqual([]);
    expect(upstream?.headers.get("x-client-request-id")).toBe(
      "gateway-attempt",
    );
    expect(events).toEqual([
      "start",
      ["authenticate", true],
      "routeStarted",
      ["routeEnded", "acquired"],
      "upstreamStarted",
      ["upstreamHeaders", 200],
      ["chunk", 11],
      "releaseStarted",
      ["released", false],
      [
        "end",
        { status: 200, streamOutcome: "completed" },
      ],
    ]);
  });

  test("reports authentication and capacity failures without starting an upstream attempt", async () => {
    const unauthorizedEvents: unknown[] = [];
    const unavailableEvents: unknown[] = [];
    const unauthorized = createProxyHandler({
      clientToken: "fleet-token",
      telemetry: recordingTelemetry(unauthorizedEvents),
      acquire: async () => undefined,
      fetchImpl: fetch,
    });
    const unavailable = createProxyHandler({
      clientToken: "fleet-token",
      telemetry: recordingTelemetry(unavailableEvents),
      acquire: async () => undefined,
      fetchImpl: fetch,
    });

    expect((await unauthorized(request("/responses", "wrong"))).status).toBe(
      401,
    );
    expect((await unavailable(request())).status).toBe(503);
    expect(unauthorizedEvents).toEqual([
      "start",
      ["authenticate", false],
      [
        "end",
        { status: 401, streamOutcome: "not_streamed" },
      ],
    ]);
    expect(unavailableEvents).toEqual([
      "start",
      ["authenticate", true],
      "routeStarted",
      ["routeEnded", "unavailable"],
      [
        "end",
        { status: 503, streamOutcome: "not_streamed" },
      ],
    ]);
  });

  test("requests an identity upstream and does not forward stale decoded content encoding", async () => {
    const upstreamBody = "decoded upstream response that must not be decompressed twice";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(Bun.gzipSync(Buffer.from(upstreamBody)), {
          headers: {
            "content-encoding": "gzip",
            "content-type": "text/plain",
          },
        }),
    });
    let upstreamAcceptEncoding: string | null | undefined;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: "api-secret",
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => undefined,
      }),
      fetchImpl: (_input, init) => {
        upstreamAcceptEncoding = new Headers(init?.headers).get("accept-encoding");
        return fetch(upstream.url, init);
      },
    });
    const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });

    try {
      const response = await fetch(new URL("/responses", gateway.url), {
        method: "POST",
        headers: {
          authorization: "Bearer fleet-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello" }),
      });

      expect(upstreamAcceptEncoding).toBe("identity");
      expect(response.headers.has("content-encoding")).toBe(false);
      expect(await response.text()).toBe(upstreamBody);
    } finally {
      gateway.stop(true);
      upstream.stop(true);
    }
  });

  test("rejects an invalid client before acquiring a route", async () => {
    let acquired = false;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => {
        acquired = true;
        return undefined;
      },
      fetchImpl: fetch,
    });
    const response = await handler(request("/responses", "wrong"));
    expect(response.status).toBe(401);
    expect(acquired).toBe(false);
  });

  test("forces identity encoding upstream and preserves a long streamed response", async () => {
    const chunks = Array.from({ length: 256 }, (_, index) =>
      new TextEncoder().encode(`data: ${index.toString().padStart(3, "0")}-${"x".repeat(1_016)}\n\n`),
    );
    const expected = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");
    let upstream: Request | undefined;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: "api-secret",
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => undefined,
      }),
      fetchImpl: async (input, init) => {
        upstream = new Request(input instanceof Request ? input.url : input.toString(), init);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const gatewayRequest = request();
    gatewayRequest.headers.set("accept-encoding", "gzip, br");

    const response = await handler(gatewayRequest);

    expect(upstream?.headers.get("accept-encoding")).toBe("identity");
    expect(await response.text()).toBe(expected);
  });

  test("classifies a Bun decoder failure from an encoded upstream", async () => {
    const compressed = Bun.gzipSync(Buffer.from("x".repeat(100_000)));
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(compressed.subarray(0, compressed.length - 8), {
          headers: { "content-encoding": "gzip" },
        }),
    });
    let observation: unknown;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: "api-secret",
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => undefined,
      }),
      fetchImpl: (_input, init) => fetch(upstream.url, init),
      observeStreamFailure(value) {
        observation = value;
      },
    });

    try {
      const response = await handler(request());
      await expect(response.arrayBuffer()).rejects.toThrow();
      expect(observation).toEqual({
        event: "upstream_stream_failure",
        upstreamEncoding: "encoded",
        failureKind: "decode",
        chunksForwarded: 0,
        bytesForwarded: 0,
      });
    } finally {
      upstream.stop(true);
    }
  });

  test("preserves privacy-safe stream failure evidence when lease cleanup also fails", async () => {
    const providerDetail = "provider route secret: error decoding response body";
    let released = false;
    let observation: unknown;
    let pullCount = 0;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: "api-secret",
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => {
          released = true;
          throw new Error("private lease cleanup detail");
        },
      }),
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pullCount++ === 0) {
                controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
                return;
              }
              controller.error(new TypeError(providerDetail));
            },
          }),
          { headers: { "content-encoding": "gzip" } },
        ),
      observeStreamFailure(value) {
        observation = value;
      },
    });

    const response = await handler(request());
    await expect(response.arrayBuffer()).rejects.toThrow(providerDetail);

    expect(observation).toEqual({
      event: "upstream_stream_failure",
      upstreamEncoding: "encoded",
      failureKind: "decode_candidate",
      chunksForwarded: 1,
      bytesForwarded: 5,
    });
    expect(JSON.stringify(observation)).not.toContain(providerDetail);
    expect(released).toBe(true);
  });

  test("does not delay stream failures for an asynchronous observer", async () => {
    let observationStarted = false;
    let resolveObservation: (() => void) | undefined;
    const observationPending = new Promise<void>((resolve) => {
      resolveObservation = resolve;
    });
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: "api-secret",
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => undefined,
      }),
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("upstream stream failed"));
            },
          }),
        ),
      observeStreamFailure() {
        observationStarted = true;
        return observationPending;
      },
    });

    const response = await handler(request());
    const readOutcome = response.arrayBuffer().then(
      () => "completed" as const,
      () => "failed" as const,
    );
    const outcome = await Promise.race([
      readOutcome,
      Bun.sleep(100).then(() => "blocked" as const),
    ]);
    resolveObservation?.();

    expect(outcome).toBe("failed");
    expect(observationStarted).toBe(true);
  });

  test("does not report downstream cancellation as an upstream stream failure", async () => {
    let markReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let observation: unknown;
    let releaseCount = 0;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: "api-secret",
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => {
          releaseCount += 1;
        },
      }),
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              markReadStarted();
            },
          }),
        ),
      observeStreamFailure(value) {
        observation = value;
      },
    });

    const response = await handler(request());
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const pendingRead = reader!.read();
    await readStarted;
    await reader!.cancel("client disconnected");
    await pendingRead;
    await Bun.sleep(0);

    expect(observation).toBeUndefined();
    expect(releaseCount).toBe(1);
  });

  test("does not report request abort as an upstream stream failure", async () => {
    let markReadStarted: () => void = () => undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let markReleased: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      markReleased = resolve;
    });
    let observation: unknown;
    const requestController = new AbortController();
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: "api-secret",
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => {
          markReleased();
        },
      }),
      fetchImpl: async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("expected upstream abort signal");
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
            pull() {
              markReadStarted();
            },
          }),
        );
      },
      observeStreamFailure(value) {
        observation = value;
      },
    });

    const response = await handler(request("/responses", "fleet-token", requestController.signal));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const pendingRead = reader!.read();
    await readStarted;
    requestController.abort();
    await expect(pendingRead).rejects.toMatchObject({ name: "AbortError" });
    await released;

    expect(observation).toBeUndefined();
  });

  test("accepts and strips the dedicated Fleet client headers", async () => {
    let upstream: Request | undefined;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: "api-secret",
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => undefined,
      }),
      fetchImpl: async (input, init) => {
        upstream = new Request(input instanceof Request ? input.url : input.toString(), init);
        return new Response("ok");
      },
    });
    const gatewayRequest = request();
    gatewayRequest.headers.delete("authorization");
    gatewayRequest.headers.set("x-ai-gateway-token", "fleet-token");
    gatewayRequest.headers.set("x-ai-gateway-session", "gateway-session");

    expect((await handler(gatewayRequest)).status).toBe(200);
    expect(upstream?.headers.has("x-ai-gateway-token")).toBe(false);
    expect(upstream?.headers.has("x-ai-gateway-session")).toBe(false);
  });

  test("strips inbound provider credential headers before forwarding", async () => {
    let upstream: Request | undefined;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: "selected-secret",
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => undefined,
      }),
      fetchImpl: async (input, init) => {
        upstream = new Request(input instanceof Request ? input.url : input.toString(), init);
        return new Response("ok");
      },
    });
    const gatewayRequest = request();
    gatewayRequest.headers.set("api-key", "inbound-api-key");
    gatewayRequest.headers.set("x-api-key", "inbound-x-api-key");

    expect((await handler(gatewayRequest)).status).toBe(200);
    expect(upstream?.headers.get("authorization")).toBe("Bearer selected-secret");
    expect(upstream?.headers.has("api-key")).toBe(false);
    expect(upstream?.headers.has("x-api-key")).toBe(false);
  });

  test("normalizes OAuth upstream headers/path and streams the real response", async () => {
    let upstream: Request | undefined;
    let released = false;
    const lease: RouteLease = {
      kind: "codex_oauth",
      accountId: "managed-a",
      providerAccountId: "provider-a",
      accessToken: "oauth-secret",
      leaseToken: "lease-a",
      renew: async () => true,
      release: async () => {
        released = true;
      },
    };
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async (sessionKey) => {
        expect(sessionKey).toBe("session-a");
        return lease;
      },
      fetchImpl: async (input, init) => {
        upstream = new Request(input instanceof Request ? input.url : input.toString(), init);
        return new Response("data: one\n\ndata: two\n\n", {
          status: 429,
          headers: { "content-type": "text/event-stream", "retry-after": "9" },
        });
      },
    });

    const response = await handler(request("/v1/responses"));
    expect(upstream?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(upstream?.headers.get("authorization")).toBe("Bearer oauth-secret");
    expect(upstream?.headers.get("chatgpt-account-id")).toBe("provider-a");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
    await Bun.sleep(0);
    expect(released).toBe(true);
  });

  test("uses an API key only when acquisition explicitly selected the fallback", async () => {
    let upstream: Request | undefined;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: "api-secret",
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => undefined,
      }),
      fetchImpl: async (input, init) => {
        upstream = new Request(input instanceof Request ? input.url : input.toString(), init);
        return new Response("ok");
      },
    });
    await handler(request("/codex/responses"));
    expect(upstream?.url).toBe("https://api.openai.com/v1/responses");
    expect(upstream?.headers.get("authorization")).toBe("Bearer api-secret");
    expect(upstream?.headers.has("chatgpt-account-id")).toBe(false);
  });

  test("forwards native compaction payloads and streams opaquely", async () => {
    const body = JSON.stringify({
      model: "gpt-test",
      input: [
        { type: "compaction", encrypted_content: "opaque-input" },
        { type: "compaction_trigger" },
      ],
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    const providerBody =
      'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque-output"}}\n\n';
    let forwardedBody: string | undefined;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "codex_oauth",
        accountId: "managed-a",
        providerAccountId: "provider-a",
        accessToken: "oauth-secret",
        leaseToken: "lease-a",
        renew: async () => true,
        release: async () => undefined,
      }),
      fetchImpl: async (input, init) => {
        forwardedBody = await new Request(
          input instanceof Request ? input.url : input.toString(),
          init,
        ).text();
        return new Response(providerBody, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const response = await handler(
      new Request("http://gateway.test/codex/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer fleet-token",
          "content-type": "application/json",
          "session-id": "session-a",
        },
        body,
      }),
    );

    expect(forwardedBody).toBe(body);
    expect(await response.text()).toBe(providerBody);
  });

  test("returns the upstream response even when local response bookkeeping fails", async () => {
    let released = false;
    const handler = createProxyHandler({
      clientToken: "fleet-token",
      acquire: async () => ({
        kind: "codex_oauth",
        accountId: "managed-a",
        providerAccountId: "provider-a",
        accessToken: "oauth-secret",
        leaseToken: "lease-a",
        renew: async () => true,
        release: async () => {
          released = true;
        },
        recordResponse: async () => {
          throw new Error("state write failed");
        },
      }),
      fetchImpl: async () => new Response("real upstream body", { status: 429 }),
    });

    const response = await handler(request());
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("real upstream body");
    expect(released).toBe(true);
  });
});

function recordingTelemetry(events: unknown[]): GatewayTelemetry {
  return {
    enabled: true,
    startRequest() {
      events.push("start");
      return {
        attemptId: "gateway-attempt",
        authenticate(authenticated) {
          events.push(["authenticate", authenticated]);
        },
        routeStarted() {
          events.push("routeStarted");
        },
        routeEnded(outcome) {
          events.push(["routeEnded", outcome]);
        },
        upstreamStarted(headers) {
          events.push("upstreamStarted");
          headers.set("x-client-request-id", "gateway-attempt");
        },
        upstreamHeaders(status) {
          events.push(["upstreamHeaders", status]);
        },
        upstreamFailed() {
          events.push("upstreamFailed");
        },
        streamChunk(bytes) {
          events.push(["chunk", bytes]);
        },
        routeReleaseStarted() {
          events.push("releaseStarted");
        },
        routeReleased(error) {
          events.push(["released", error !== undefined]);
        },
        end(outcome: GatewayRequestOutcome) {
          events.push(["end", outcome]);
        },
      };
    },
  };
}
