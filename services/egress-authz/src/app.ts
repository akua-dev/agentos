import {
  ProviderDecisionReferenceGenerator,
  ProviderPolicyDecisionPoint,
  WorkloadIdentityAuthenticator,
  createProviderAuthorizationHttpHandler,
} from "@akua-dev/agentos";
import {
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  Semaphore,
} from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

const PositiveInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
);

const EgressAuthorizerLimitsSchema = Schema.Struct({
  maximumConcurrentRequests: PositiveInteger,
  requestTimeoutMillis: PositiveInteger,
  readinessTimeoutMillis: PositiveInteger,
  maximumHeaderCount: PositiveInteger,
  maximumHeaderBytes: PositiveInteger,
  maximumHeaderValueBytes: PositiveInteger,
});

export interface EgressAuthorizerLimits {
  readonly maximumConcurrentRequests: number;
  readonly requestTimeoutMillis: number;
  readonly readinessTimeoutMillis: number;
  readonly maximumHeaderCount: number;
  readonly maximumHeaderBytes: number;
  readonly maximumHeaderValueBytes: number;
  readonly clock?: Effect.Effect<number>;
}

export class EgressAuthorizerConfigurationError extends Schema.TaggedErrorClass<EgressAuthorizerConfigurationError>()(
  "EgressAuthorizerConfigurationError",
  { code: Schema.Literal("invalid_limits") },
) {}

export class EgressAuthorizerReadiness extends Context.Service<
  EgressAuthorizerReadiness,
  {
    readonly check: Effect.Effect<boolean, unknown>;
  }
>()("agentos/egress-authz/EgressAuthorizerReadiness") {}

export type EgressAuthorizerRequestHandler = (
  request: Request,
) => Effect.Effect<Response>;

export const makeEgressAuthorizerRequestHandler = Effect.fn(
  "agentos.egressAuthz.makeRequestHandler",
)(function*(options: EgressAuthorizerLimits) {
  const limits = yield* Schema.decodeUnknownEffect(
    EgressAuthorizerLimitsSchema,
    { onExcessProperty: "ignore" },
  )(options).pipe(
    Effect.mapError(() =>
      EgressAuthorizerConfigurationError.make({ code: "invalid_limits" })
    ),
  );
  const readiness = yield* EgressAuthorizerReadiness;
  const decisionReferences = yield* ProviderDecisionReferenceGenerator;
  const authorize = yield* createProviderAuthorizationHttpHandler({
    clock: options.clock,
    id: decisionReferences.next,
  });
  const permits = yield* Semaphore.make(limits.maximumConcurrentRequests);

  const handleAuthorization = Effect.fn(
    "agentos.egressAuthz.handleAuthorization",
  )((request: Request) =>
    permits.withPermitsIfAvailable(1)(
      authorize(request).pipe(
        Effect.timeoutOption(limits.requestTimeoutMillis),
      ),
    ).pipe(
      Effect.map((permitted) => {
        if (Option.isNone(permitted)) return overloadedResponse();
        return Option.match(permitted.value, {
          onNone: unavailableResponse,
          onSome: (response) => response,
        });
      }),
    ));

  const handler: EgressAuthorizerRequestHandler = Effect.fn(
    "agentos.egressAuthz.handleRequest",
  )(function*(request: Request) {
    const url = URL.canParse(request.url) ? new URL(request.url) : null;
    if (url === null) return invalidRequestResponse();
    if (url.pathname === "/livez") {
      return request.method === "GET"
        ? Response.json({ status: "alive" })
        : methodNotAllowedResponse();
    }
    if (url.pathname === "/readyz") {
      if (request.method !== "GET") return methodNotAllowedResponse();
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
    }
    if (url.pathname !== "/authorize") return notFoundResponse();
    if (request.method !== "POST") return methodNotAllowedResponse();
    if (!headersWithinLimits(request.headers, limits)) {
      return invalidRequestResponse();
    }
    return yield* handleAuthorization(request);
  });
  return handler;
});

export function makeEgressAuthorizerRoutesLayer(
  options: EgressAuthorizerLimits,
) {
  return Layer.effectDiscard(Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter;
    const handler = yield* makeEgressAuthorizerRequestHandler(options);
    yield* router.add("*", "/*", (request) =>
      HttpServerRequest.toWeb(request).pipe(
        Effect.flatMap(handler),
        Effect.map(HttpServerResponse.fromWeb),
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.fromWeb(invalidRequestResponse()))
        ),
      ));
  }));
}

function headersWithinLimits(
  headers: Headers,
  limits: typeof EgressAuthorizerLimitsSchema.Type,
): boolean {
  const encoder = new TextEncoder();
  let count = 0;
  let bytes = 0;
  for (const [name, value] of headers) {
    count += 1;
    const valueBytes = encoder.encode(value).byteLength;
    bytes += encoder.encode(name).byteLength + valueBytes;
    if (
      count > limits.maximumHeaderCount ||
      valueBytes > limits.maximumHeaderValueBytes ||
      bytes > limits.maximumHeaderBytes
    ) {
      return false;
    }
  }
  return true;
}

function invalidRequestResponse(): Response {
  return Response.json({ error: "invalid_request" }, { status: 400 });
}

function methodNotAllowedResponse(): Response {
  return Response.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { allow: "GET, POST" } },
  );
}

function notFoundResponse(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}

function overloadedResponse(): Response {
  return Response.json(
    { error: "authorization_overloaded" },
    { status: 503, headers: { "retry-after": "1" } },
  );
}

function unavailableResponse(): Response {
  return Response.json(
    { error: "authorization_unavailable" },
    { status: 503 },
  );
}
