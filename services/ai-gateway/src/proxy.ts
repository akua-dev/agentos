import { timingSafeEqual } from "node:crypto";
import type { RouteLease } from "./types.ts";

const ALLOWED_PATHS = new Set(["/responses", "/v1/responses", "/codex/responses"]);
const REQUEST_HEADERS_TO_REMOVE = new Set([
  "authorization",
  "api-key",
  "chatgpt-account-id",
  "host",
  "content-length",
  "connection",
  "proxy-authorization",
  "proxy-authenticate",
  "x-api-key",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const RESPONSE_HEADERS_TO_REMOVE = new Set([
  "connection",
  "content-encoding",
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

export type UpstreamEncoding = "identity" | "encoded";
export type StreamFailureKind =
  | "abort"
  | "decode"
  | "decode_candidate"
  | "timeout"
  | "transport"
  | "unknown";

export interface StreamFailureObservation {
  event: "upstream_stream_failure";
  upstreamEncoding: UpstreamEncoding;
  failureKind: StreamFailureKind;
  chunksForwarded: number;
  bytesForwarded: number;
}

export interface ProxyHandlerOptions {
  clientToken: string;
  acquire(sessionKey: string | undefined, signal: AbortSignal): Promise<RouteLease | undefined>;
  fetchImpl: FetchImplementation;
  heartbeatMs?: number;
  observeStreamFailure?(
    observation: StreamFailureObservation,
  ): void | Promise<void>;
}

export function createProxyHandler(options: ProxyHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    if (!isClientAuthorized(request, options.clientToken)) {
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
    headers.set("accept-encoding", "identity");
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
      console.error("ai-gateway: response bookkeeping failed");
    }

    const upstreamEncoding = classifyUpstreamEncoding(upstream.headers);
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

    const body = streamWithLease(
      upstream.body,
      lease,
      options.heartbeatMs ?? 40_000,
      upstreamEncoding,
      options.observeStreamFailure ?? logStreamFailure,
    );
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  };
}

export function isClientAuthorized(request: Request, expected: string): boolean {
  if (!expected) return false;
  const dedicated = request.headers.get("x-ai-gateway-token")?.trim();
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
    "x-ai-gateway-session",
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
  headers.delete("x-ai-gateway-token");
  headers.delete("x-ai-gateway-session");
  for (const name of REQUEST_HEADERS_TO_REMOVE) headers.delete(name);
  return headers;
}

function classifyUpstreamEncoding(headers: Headers): UpstreamEncoding {
  const value = headers.get("content-encoding")?.trim().toLowerCase();
  return value === undefined || value === "" || value === "identity" ? "identity" : "encoded";
}

function streamWithLease(
  body: ReadableStream<Uint8Array>,
  lease: RouteLease,
  heartbeatMs: number,
  upstreamEncoding: UpstreamEncoding,
  observeStreamFailure: (observation: StreamFailureObservation) => void | Promise<void>,
) {
  const reader = body.getReader();
  let finished = false;
  let chunksForwarded = 0;
  let bytesForwarded = 0;
  const timer = setInterval(() => {
    void lease.renew().catch(() => undefined);
  }, heartbeatMs);
  timer.unref?.();

  const finish = async () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    try {
      await lease.release();
    } catch {
      // Cleanup must never replace the provider response or original stream
      // failure, and the private routing error is not safe to log.
      console.error("ai-gateway: lease release failed");
    }
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
        chunksForwarded = boundedAdd(chunksForwarded, 1);
        bytesForwarded = boundedAdd(bytesForwarded, next.value.byteLength);
      } catch (error) {
        await finish();
        await reportStreamFailure(observeStreamFailure, {
          event: "upstream_stream_failure",
          upstreamEncoding,
          failureKind: classifyStreamFailure(error, upstreamEncoding),
          chunksForwarded,
          bytesForwarded,
        });
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await finish();
    },
  });
}

function boundedAdd(total: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, total + Math.min(Number.MAX_SAFE_INTEGER, increment));
}

function classifyStreamFailure(
  error: unknown,
  upstreamEncoding: UpstreamEncoding,
): StreamFailureKind {
  const terms: string[] = [];
  let current = error;
  for (let depth = 0; depth < 3 && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      terms.push(current.name, current.message);
      current = current.cause;
      continue;
    }
    if (typeof current === "object" && current !== null) {
      const record = current as Record<string, unknown>;
      if (typeof record.name === "string") terms.push(record.name);
      if (typeof record.message === "string") terms.push(record.message);
      if (typeof record.code === "string") terms.push(record.code);
      current = record.cause;
      continue;
    }
    if (typeof current === "string") terms.push(current);
    break;
  }
  if (terms.length === 0) {
    try {
      terms.push(String(error));
    } catch {
      // Classification is best effort; the observation never includes this value.
    }
  }
  const value = terms.join(" ").toLowerCase();
  if (/abort|cancel/.test(value)) return "abort";
  if (/brotli|content.?encoding|decode|decompress|gzip|zlib/.test(value)) return "decode";
  if (/timeout|timed.?out/.test(value)) return "timeout";
  if (/connection|econn|network|socket|transport|und_err/.test(value)) return "transport";
  return upstreamEncoding === "encoded" ? "decode_candidate" : "unknown";
}

async function reportStreamFailure(
  observe: (observation: StreamFailureObservation) => void | Promise<void>,
  observation: StreamFailureObservation,
): Promise<void> {
  try {
    await observe(observation);
  } catch {
    console.error("ai-gateway: stream failure observation failed");
  }
}

function logStreamFailure(observation: StreamFailureObservation): void {
  console.error(
    `ai-gateway: event=${observation.event} upstream_encoding=${observation.upstreamEncoding} failure_kind=${observation.failureKind} chunks_forwarded=${observation.chunksForwarded} bytes_forwarded=${observation.bytesForwarded}`,
  );
}

function jsonResponse(status: number, body: Record<string, string>): Response {
  return Response.json(body, { status });
}
