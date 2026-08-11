import { sanitizeRequestHeaders } from "@akua-dev/codex-router/codex";
import { Config, Effect, FileSystem, Option, Schema } from "effect";

import {
  defaultAIGatewayGracefulShutdownMillis,
  defaultAIGatewayIdleTimeoutSeconds,
} from "./config.ts";

const maximumTokenBytes = 16 * 1024;
const jwtLike = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const allowedPaths = new Set(["/v1/responses", "/v1/responses/compact"]);
const reviewedAgentgatewayOrigin =
  "http://agentgateway-openai.agentos.svc.cluster.local:8788";
const assignmentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const workloadClientProxyHostname = "127.0.0.1";
export class WorkloadClientProxyError extends Schema.TaggedErrorClass<WorkloadClientProxyError>()(
  "WorkloadClientProxyError",
  {
    code: Schema.Literals([
      "invalid_request",
      "token_unavailable",
      "upstream_unavailable",
    ]),
  },
) {}

export interface WorkloadClientProxyOptions {
  readonly upstreamBaseUrl: URL;
  readonly tokenPath: string;
  readonly assignmentId?: string;
  readonly forward: (
    request: Request,
  ) => Effect.Effect<Response, WorkloadClientProxyError>;
}

const Port = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
  Schema.check(Schema.isLessThanOrEqualTo(65_535)),
);
const Configuration = Schema.Struct({
  port: Port,
  idleTimeoutSeconds: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(255),
    ),
  ),
  tokenPath: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  upstreamBaseUrl: Schema.URL,
  assignmentId: Schema.Union([
    Schema.Literal(""),
    Schema.String.pipe(Schema.check(Schema.isPattern(assignmentIdPattern))),
  ]),
  gracefulShutdownMillis: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
});

export class WorkloadClientProxyConfigurationError extends Schema.TaggedErrorClass<WorkloadClientProxyConfigurationError>()(
  "WorkloadClientProxyConfigurationError",
  { code: Schema.Literal("invalid_configuration") },
) {}

function configurationError() {
  return WorkloadClientProxyConfigurationError.make({
    code: "invalid_configuration",
  });
}

function isValidUpstreamBaseUrl(url: URL) {
  return url.origin === reviewedAgentgatewayOrigin &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
}

export const loadWorkloadClientProxyConfig = Effect.fn(
  "agentos.aiGateway.workloadClient.loadConfig",
)(function*() {
  const raw = yield* Config.all({
    port: Config.int("AI_GATEWAY_WORKLOAD_PROXY_PORT").pipe(
      Config.withDefault(8_790),
    ),
    idleTimeoutSeconds: Config.int("AI_GATEWAY_IDLE_TIMEOUT_SECONDS").pipe(
      Config.withDefault(defaultAIGatewayIdleTimeoutSeconds),
    ),
    tokenPath: Config.string("AGENTOS_EGRESS_TOKEN_FILE").pipe(
      Config.withDefault("/var/run/secrets/agentos-egress/token"),
    ),
    upstreamBaseUrl: Config.url("AI_GATEWAY_URL"),
    assignmentId: Config.string("AGENTOS_ASSIGNMENT_ID").pipe(
      Config.withDefault(""),
    ),
    gracefulShutdownMillis: Config.int("AI_GATEWAY_GRACEFUL_SHUTDOWN_MILLIS").pipe(
      Config.withDefault(defaultAIGatewayGracefulShutdownMillis),
    ),
  }).pipe(Effect.mapError(configurationError));
  const config = yield* Schema.decodeUnknownEffect(Configuration)(raw).pipe(
    Effect.mapError(configurationError),
  );
  if (!isValidUpstreamBaseUrl(config.upstreamBaseUrl)) {
    return yield* configurationError();
  }
  return {
    ...config,
    hostname: workloadClientProxyHostname,
    assignmentId: config.assignmentId === "" ? undefined : config.assignmentId,
  };
});

function proxyError(code: WorkloadClientProxyError["code"]) {
  return WorkloadClientProxyError.make({ code });
}

export const readProjectedWorkloadToken = Effect.fn(
  "agentos.aiGateway.workloadClient.readToken",
)(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const bytes = yield* Effect.scoped(Effect.gen(function*() {
    const file = yield* fileSystem.open(path, { flag: "r" });
    const read = yield* file.readAlloc(maximumTokenBytes + 1);
    return Option.getOrElse(read, () => new Uint8Array());
  })).pipe(
    Effect.mapError(() => proxyError("token_unavailable")),
  );
  if (bytes.length === 0 || bytes.length > maximumTokenBytes) {
    return yield* proxyError("token_unavailable");
  }
  const token = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => proxyError("token_unavailable"),
  });
  if (token.trim() !== token || !jwtLike.test(token)) {
    return yield* proxyError("token_unavailable");
  }
  return token;
});

function forwardedHeaders(
  input: Headers,
  token: string,
  assignmentId: string | undefined,
) {
  const headers = sanitizeRequestHeaders(input);
  for (const name of Array.from(headers.keys())) {
    if (name.toLowerCase().startsWith("x-agentos-")) {
      headers.delete(name);
    }
  }
  headers.set("authorization", `Bearer ${token}`);
  if (assignmentId !== undefined) {
    headers.set("x-agentos-assignment-id", assignmentId);
  }
  return headers;
}

export const workloadClientProxyReadinessResponse = Effect.fn(
  "agentos.aiGateway.workloadClient.readiness",
)(function*(tokenPath: string) {
  return yield* readProjectedWorkloadToken(tokenPath).pipe(
    Effect.as(Response.json({ status: "ready" })),
    Effect.catchTag("WorkloadClientProxyError", () =>
      Effect.succeed(Response.json({ status: "not_ready" }, { status: 503 }))),
  );
});

export const makeWorkloadClientProxyHandler = Effect.fn(
  "agentos.aiGateway.workloadClient.makeHandler",
)(function*(options: WorkloadClientProxyOptions) {
  if (!isValidUpstreamBaseUrl(options.upstreamBaseUrl)) {
    return yield* proxyError("invalid_request");
  }
  const handle = Effect.fn("agentos.aiGateway.workloadClient.forward")(
    function*(request: Request) {
      const incoming = yield* Effect.try({
        try: () => new URL(request.url),
        catch: () => proxyError("invalid_request"),
      });
      if (
        request.method !== "POST" ||
        !allowedPaths.has(incoming.pathname) ||
        incoming.search !== "" ||
        incoming.hash !== ""
      ) {
        return yield* proxyError("invalid_request");
      }
      const token = yield* readProjectedWorkloadToken(options.tokenPath);
      const upstream = new URL(incoming.pathname, options.upstreamBaseUrl);
      const forwarded = yield* Effect.try({
        try: () => {
          const init: RequestInit & { readonly duplex: "half" } = {
            method: "POST",
            headers: forwardedHeaders(
              request.headers,
              token,
              options.assignmentId,
            ),
            body: request.body,
            redirect: "manual",
            signal: request.signal,
            duplex: "half",
          };
          return new Request(upstream.toString(), init);
        },
        catch: () => proxyError("invalid_request"),
      });
      return yield* options.forward(forwarded);
    },
  );
  return handle;
});

export function workloadClientProxyErrorResponse(
  error: WorkloadClientProxyError,
) {
  const status = error.code === "invalid_request"
    ? 404
    : error.code === "token_unavailable"
    ? 503
    : 502;
  return Response.json({ error: error.code }, { status });
}
