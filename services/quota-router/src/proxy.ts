import { timingSafeEqual } from "node:crypto";
import type { RouteLease } from "./types.ts";

const ALLOWED_PATHS = new Set(["/responses", "/v1/responses", "/codex/responses"]);
const REQUEST_HEADERS_TO_REMOVE = new Set([
  "authorization",
  "chatgpt-account-id",
  "host",
  "content-length",
  "connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const RESPONSE_HEADERS_TO_REMOVE = new Set([
  "connection",
  "content-length",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ProxyHandlerOptions {
  clientToken: string;
  acquire(sessionKey: string | undefined, signal: AbortSignal): Promise<RouteLease | undefined>;
  fetchImpl: FetchImplementation;
  heartbeatMs?: number;
}

export function createProxyHandler(options: ProxyHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    if (!isAuthorized(request, options.clientToken)) {
      return jsonResponse(401, { error: "unauthorized" });
    }
    const url = new URL(request.url);
    if (request.method !== "POST" || !ALLOWED_PATHS.has(url.pathname)) {
      return jsonResponse(404, { error: "not_found" });
    }

    const sessionKey = explicitSessionKey(request.headers);
    const lease = await options.acquire(sessionKey, request.signal);
    if (!lease) return jsonResponse(503, { error: "no_eligible_account" });

    const headers = sanitizedRequestHeaders(request.headers);
    headers.set("authorization", `Bearer ${lease.accessToken}`);
    let upstreamUrl: string;
    if (lease.kind === "codex_oauth") {
      upstreamUrl = "https://chatgpt.com/backend-api/codex/responses";
      headers.set("chatgpt-account-id", lease.providerAccountId);
    } else {
      upstreamUrl = "https://api.openai.com/v1/responses";
      headers.delete("chatgpt-account-id");
    }

    let upstream: Response;
    try {
      upstream = await options.fetchImpl(upstreamUrl, {
        method: "POST",
        headers,
        body: request.body,
        signal: request.signal,
        // Required by Node-compatible fetch implementations for streamed bodies.
        duplex: "half",
      } as RequestInit & { duplex: "half" });
    } catch (error) {
      await lease.release();
      throw error;
    }
    try {
      await lease.recordResponse?.(upstream.status, upstream.headers);
    } catch {
      // The caller must still see the real upstream result. State repair can be
      // retried independently; never replace a provider response with it.
      console.error("quota-router: response bookkeeping failed");
    }

    const responseHeaders = new Headers(upstream.headers);
    for (const name of RESPONSE_HEADERS_TO_REMOVE) responseHeaders.delete(name);
    if (!upstream.body) {
      await lease.release();
      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    const body = streamWithLease(upstream.body, lease, options.heartbeatMs ?? 40_000);
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  };
}

function isAuthorized(request: Request, expected: string): boolean {
  if (!expected) return false;
  const dedicated = request.headers.get("x-quota-router-token")?.trim();
  const authorization = request.headers.get("authorization")?.trim();
  const bearer = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : undefined;
  return constantTimeEqual(dedicated ?? bearer ?? "", expected);
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function explicitSessionKey(headers: Headers): string | undefined {
  for (const name of [
    "x-quota-router-session",
    "session-id",
    "x-codex-session-id",
    "x-codex-window-id",
    "x-codex-parent-thread-id",
    "x-codex-turn-state",
  ]) {
    const value = headers.get(name)?.trim();
    if (value) return value.slice(0, 256);
  }
  return undefined;
}

function sanitizedRequestHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  headers.delete("x-quota-router-token");
  headers.delete("x-quota-router-session");
  for (const name of REQUEST_HEADERS_TO_REMOVE) headers.delete(name);
  return headers;
}

function streamWithLease(body: ReadableStream<Uint8Array>, lease: RouteLease, heartbeatMs: number) {
  const reader = body.getReader();
  let finished = false;
  const timer = setInterval(() => {
    void lease.renew().catch(() => undefined);
  }, heartbeatMs);
  timer.unref?.();

  const finish = async () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    await lease.release();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await finish();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        await finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await finish();
    },
  });
}

function jsonResponse(status: number, body: Record<string, string>): Response {
  return Response.json(body, { status });
}
