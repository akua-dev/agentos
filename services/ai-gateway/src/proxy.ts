import { timingSafeEqual } from "node:crypto";
import {
  extractSessionKey,
  isSupportedResponsePath,
  resolveUpstreamTarget,
  sanitizeRequestHeaders,
  sanitizeResponseHeaders,
} from "@akua-dev/codex-router/codex";
import { Effect, Option, Result } from "effect";
import {
  createNoopGatewayTelemetry,
  type GatewayRequestTelemetry,
  type GatewayTelemetry,
} from "./telemetry.ts";
import type { RouteLease } from "./types.ts";

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
  acquire(
    sessionKey: string | undefined,
    signal: AbortSignal,
    telemetry: GatewayRequestTelemetry,
  ): Promise<RouteLease | undefined>;
  fetchImpl: FetchImplementation;
  heartbeatMs?: number;
  telemetry?: GatewayTelemetry;
  observeStreamFailure?(
    observation: StreamFailureObservation,
  ): void | Promise<void>;
}

export function createProxyHandler(options: ProxyHandlerOptions) {
  return async (request: Request): Promise<Response> => {
    const telemetry = (
      options.telemetry ?? createNoopGatewayTelemetry()
    ).startRequest(request);
    const authenticated = isClientAuthorized(request, options.clientToken);
    telemetry.authenticate(authenticated);
    if (!authenticated) {
      telemetry.end({ status: 401, streamOutcome: "not_streamed" });
      return jsonResponse(401, { error: "unauthorized" });
    }
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      !isSupportedResponsePath(url.pathname)
    ) {
      telemetry.end({ status: 404, streamOutcome: "not_streamed" });
      return jsonResponse(404, { error: "not_found" });
    }

    const sessionResult = Effect.runSync(
      Effect.result(extractSessionKey(request.headers)),
    );
    if (Result.isFailure(sessionResult)) {
      telemetry.end({ status: 400, streamOutcome: "not_streamed" });
      return jsonResponse(400, { error: "invalid_session" });
    }
    const sessionKey = Option.getOrUndefined(sessionResult.success);
    telemetry.routeStarted();
    let lease: RouteLease | undefined;
    try {
      lease = await options.acquire(sessionKey, request.signal, telemetry);
    } catch (error) {
      telemetry.routeEnded("error", error);
      telemetry.end({
        error,
        streamOutcome: "not_streamed",
      });
      throw error;
    }
    if (!lease) {
      telemetry.routeEnded("unavailable");
      telemetry.end({ status: 503, streamOutcome: "not_streamed" });
      return jsonResponse(503, { error: "no_eligible_account" });
    }
    telemetry.routeEnded("acquired");

    const headers = sanitizeRequestHeaders(request.headers);
    for (const name of [...headers.keys()]) {
      if (name.startsWith("x-agentos-")) headers.delete(name);
    }
    headers.set("accept-encoding", "identity");
    headers.set("authorization", `Bearer ${lease.accessToken}`);
    let accountKind: "codex_subscription" | "openai_api_key";
    if (lease.kind === "codex_oauth") {
      accountKind = "codex_subscription";
      headers.set("chatgpt-account-id", lease.providerAccountId);
    } else {
      accountKind = "openai_api_key";
      headers.delete("chatgpt-account-id");
    }
    const upstreamUrl = resolveUpstreamTarget(url.pathname, accountKind);
    telemetry.upstreamStarted(headers);

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
      telemetry.upstreamFailed(error);
      await releaseLease(lease, telemetry);
      telemetry.end({
        error,
        streamOutcome: request.signal.aborted
          ? "aborted"
          : "upstream_error",
      });
      throw error;
    }
    telemetry.upstreamHeaders(upstream.status, upstream.headers);
    try {
      await lease.recordResponse?.(upstream.status, upstream.headers);
    } catch {
      // The caller must still see the real upstream result. State repair can be
      // retried independently; never replace a provider response with it.
      console.error("ai-gateway: response bookkeeping failed");
    }

    const upstreamEncoding = classifyUpstreamEncoding(upstream.headers);
    const responseHeaders = sanitizeResponseHeaders(upstream.headers);
    if (!upstream.body) {
      await releaseLease(lease, telemetry);
      telemetry.end({
        status: upstream.status,
        streamOutcome: "not_streamed",
      });
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
      request.signal,
      upstreamEncoding,
      options.observeStreamFailure ?? logStreamFailure,
      telemetry,
      upstream.status,
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

function classifyUpstreamEncoding(headers: Headers): UpstreamEncoding {
  const value = headers.get("content-encoding")?.trim().toLowerCase();
  return value === undefined || value === "" || value === "identity" ? "identity" : "encoded";
}

function streamWithLease(
  body: ReadableStream<Uint8Array>,
  lease: RouteLease,
  heartbeatMs: number,
  downstreamSignal: AbortSignal,
  upstreamEncoding: UpstreamEncoding,
  observeStreamFailure: (observation: StreamFailureObservation) => void | Promise<void>,
  telemetry: GatewayRequestTelemetry,
  upstreamStatus: number,
) {
  const reader = body.getReader();
  let finished = false;
  let chunksForwarded = 0;
  let bytesForwarded = 0;
  const timer = setInterval(() => {
    void lease.renew().catch(() => undefined);
  }, heartbeatMs);
  timer.unref?.();

  const finish = async (
    streamOutcome:
      | "completed"
      | "client_disconnect"
      | "aborted"
      | "upstream_error",
    error?: unknown,
  ) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    await releaseLease(lease, telemetry);
    telemetry.end({
      status: upstreamStatus,
      ...(error === undefined ? {} : { error }),
      streamOutcome,
    });
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (error) {
        const downstreamAborted = downstreamSignal.aborted;
        controller.error(error);
        if (!downstreamAborted) {
          const observation: StreamFailureObservation = {
            event: "upstream_stream_failure",
            upstreamEncoding,
            failureKind: classifyStreamFailure(error, upstreamEncoding),
            chunksForwarded,
            bytesForwarded,
          };
          void reportStreamFailure(observeStreamFailure, observation);
        }
        await finish(
          downstreamAborted ? "aborted" : "upstream_error",
          error,
        );
        return;
      }

      if (next.done) {
        await finish("completed");
        try {
          controller.close();
        } catch {
          await finish("client_disconnect");
        }
        return;
      }

      try {
        controller.enqueue(next.value);
      } catch {
        await finish(
          downstreamSignal.aborted ? "aborted" : "client_disconnect",
        );
        return;
      }
      chunksForwarded = boundedAdd(chunksForwarded, 1);
      bytesForwarded = boundedAdd(bytesForwarded, next.value.byteLength);
      telemetry.streamChunk(next.value.byteLength);
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await finish(
        downstreamSignal.aborted ? "aborted" : "client_disconnect",
      );
    },
  });
}

async function releaseLease(
  lease: RouteLease,
  telemetry: GatewayRequestTelemetry,
) {
  telemetry.routeReleaseStarted();
  try {
    await lease.release();
    telemetry.routeReleased();
  } catch (error) {
    telemetry.routeReleased(error);
    // Cleanup must never replace the provider response or original stream
    // failure, and the private routing error is not safe to log.
    console.error("ai-gateway: lease release failed");
  }
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
