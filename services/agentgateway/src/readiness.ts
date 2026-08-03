import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

const PositiveInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
);
const ReadinessLimitsSchema = Schema.Struct({
  readinessTimeoutMillis: PositiveInteger,
});

export interface AgentGatewayReadinessLimits {
  readonly readinessTimeoutMillis: number;
}

export class AgentGatewayReadinessCheck extends Context.Service<
  AgentGatewayReadinessCheck,
  { readonly check: Effect.Effect<boolean, unknown> }
>()("agentos/agentgateway/AgentGatewayReadinessCheck") {}

export interface AgentGatewayProbeOptions {
  readonly readinessUrl: URL;
  readonly metricsUrl: URL;
  readonly maximumMetricsBytes: number;
}

export class AgentGatewayProbeError extends Schema.TaggedErrorClass<AgentGatewayProbeError>()(
  "AgentGatewayProbeError",
  {
    code: Schema.Literals([
      "dependency_unavailable",
      "response_too_large",
    ]),
  },
) {}

interface BoundedBody {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly length: number;
}

function emptyBody(): BoundedBody {
  return { chunks: [], length: 0 };
}

const synchronizedMetric =
  /^(?:agentgateway_)?config_synchronized(?:\{[^}\n]*\})?\s+(\S+)(?:\s+\d+)?$/;

export function hasSynchronizedConfiguration(metrics: string): boolean {
  const values = metrics
    .split("\n")
    .map((line) => synchronizedMetric.exec(line.trim())?.[1])
    .filter((value) => value !== undefined)
    .map(Number);
  return values.length > 0 && values.every((value) => value === 1);
}

const readBoundedText = Effect.fn("agentos.agentgateway.readProbeResponse")(
  function*(
    response: HttpClientResponse.HttpClientResponse,
    maximumBytes: number,
  ) {
    const declaredLength = Number(response.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      return yield* AgentGatewayProbeError.make({
        code: "response_too_large",
      });
    }
    const body = yield* response.stream.pipe(
      Stream.runFoldEffect(emptyBody, (state, chunk) => {
        const length = state.length + chunk.byteLength;
        return length > maximumBytes
          ? Effect.fail(AgentGatewayProbeError.make({
            code: "response_too_large",
          }))
          : Effect.succeed({
            chunks: [...state.chunks, chunk],
            length,
          });
      }),
      Effect.mapError((error) =>
        error instanceof AgentGatewayProbeError
          ? error
          : AgentGatewayProbeError.make({ code: "dependency_unavailable" })
      ),
    );
    const bytes = new Uint8Array(body.length);
    let offset = 0;
    for (const chunk of body.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  },
);

export const probeAgentGateway = Effect.fn("agentos.agentgateway.probe")(
  function*(
    client: HttpClient.HttpClient,
    options: AgentGatewayProbeOptions,
  ) {
    const native = yield* client.get(options.readinessUrl).pipe(
      Effect.mapError(() =>
        AgentGatewayProbeError.make({ code: "dependency_unavailable" })
      ),
    );
    if (native.status < 200 || native.status >= 300) return false;

    const metrics = yield* client.get(options.metricsUrl).pipe(
      Effect.mapError(() =>
        AgentGatewayProbeError.make({ code: "dependency_unavailable" })
      ),
    );
    if (metrics.status < 200 || metrics.status >= 300) return false;
    return hasSynchronizedConfiguration(
      yield* readBoundedText(metrics, options.maximumMetricsBytes),
    );
  },
);

export type AgentGatewayReadinessRequestHandler = (
  request: Request,
) => Effect.Effect<Response>;

export const makeAgentGatewayReadinessRequestHandler = Effect.fn(
  "agentos.agentgateway.makeReadinessRequestHandler",
)(function*(options: AgentGatewayReadinessLimits) {
  const limits = yield* Schema.decodeUnknownEffect(ReadinessLimitsSchema)(
    options,
  );
  const readiness = yield* AgentGatewayReadinessCheck;

  const handler: AgentGatewayReadinessRequestHandler = Effect.fn(
    "agentos.agentgateway.handleReadinessRequest",
  )(function*(request: Request) {
    const url = URL.canParse(request.url) ? new URL(request.url) : null;
    if (url === null) return Response.json({ error: "invalid_request" }, {
      status: 400,
    });
    if (request.method !== "GET") {
      return Response.json({ error: "method_not_allowed" }, {
        status: 405,
        headers: { allow: "GET" },
      });
    }
    if (url.pathname === "/livez") {
      return Response.json({ status: "alive" });
    }
    if (url.pathname !== "/readyz") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }

    const result = yield* readiness.check.pipe(
      Effect.timeoutOption(limits.readinessTimeoutMillis),
      Effect.option,
    );
    const ready = Option.isSome(result) &&
      Option.isSome(result.value) && result.value.value;
    return Response.json(
      { status: ready ? "ready" : "not_ready" },
      { status: ready ? 200 : 503 },
    );
  });
  return handler;
});

export function makeAgentGatewayReadinessRoutesLayer(
  options: AgentGatewayReadinessLimits,
) {
  return Layer.effectDiscard(Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter;
    const handler = yield* makeAgentGatewayReadinessRequestHandler(options);
    yield* router.add("*", "/*", (request) =>
      HttpServerRequest.toWeb(request).pipe(
        Effect.flatMap(handler),
        Effect.map(HttpServerResponse.fromWeb),
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.fromWeb(
            Response.json({ status: "not_ready" }, { status: 503 }),
          ))
        ),
      ));
  }));
}
