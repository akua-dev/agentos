import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Schema,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";

import {
  ProviderBudgetSettlementReportV1Schema,
  type ProviderBudgetSettlementReportV1,
} from "./provider-budget.ts";

const PositiveInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
);
const DecisionRef = ProviderBudgetSettlementReportV1Schema.fields.decisionRef;

export const AGENTOS_PROVIDER_BUDGET_SETTLEMENT_BASE_URL =
  "http://agentos-egress-authz.agentos.svc.cluster.local:9001";

export const ProviderBudgetSettlementReceiptV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  decisionRef: DecisionRef,
  outcome: Schema.Literal("settled"),
});

export type ProviderBudgetSettlementReceiptV1 =
  typeof ProviderBudgetSettlementReceiptV1Schema.Type;

const ProviderBudgetSettlementReadinessV1Schema = Schema.Struct({
  status: Schema.Literal("ready"),
});

const ProviderBudgetSettlementHttpOptionsSchema = Schema.Struct({
  baseUrl: Schema.String.pipe(Schema.check(Schema.isMaxLength(2_048))),
  tokenPath: Schema.String.pipe(
    Schema.check(Schema.isNonEmpty()),
    Schema.check(Schema.isMaxLength(4_096)),
  ),
  timeoutMillis: PositiveInteger,
  maximumResponseBytes: PositiveInteger,
});

export interface ProviderBudgetSettlementHttpOptions {
  readonly baseUrl: string;
  readonly tokenPath: string;
  readonly timeoutMillis: number;
  readonly maximumResponseBytes: number;
}

const ProviderBudgetSettlementHttpErrorCode = Schema.Literals([
  "invalid_configuration",
  "invalid_report",
  "credential_unavailable",
  "request_failed",
  "timeout",
  "unauthorized",
  "forbidden",
  "dependency_unavailable",
  "response_too_large",
  "invalid_response",
]);

export class ProviderBudgetSettlementHttpError extends Schema.TaggedErrorClass<ProviderBudgetSettlementHttpError>()(
  "ProviderBudgetSettlementHttpError",
  {
    code: ProviderBudgetSettlementHttpErrorCode,
    status: Schema.NullOr(Schema.Number),
  },
) {}

export class ProviderBudgetSettlementReporter extends Context.Service<
  ProviderBudgetSettlementReporter,
  {
    readonly report: (
      report: ProviderBudgetSettlementReportV1,
    ) => Effect.Effect<
      ProviderBudgetSettlementReceiptV1,
      ProviderBudgetSettlementHttpError
    >;
  }
>()("agentos/access/ProviderBudgetSettlementReporter") {}

export class ProviderBudgetSettlementReadiness extends Context.Service<
  ProviderBudgetSettlementReadiness,
  {
    readonly check: Effect.Effect<void, ProviderBudgetSettlementHttpError>;
  }
>()("agentos/access/ProviderBudgetSettlementReadiness") {}

export function makeProviderBudgetSettlementHttpLayer(
  untrustedOptions: ProviderBudgetSettlementHttpOptions,
) {
  return Layer.effectContext(
    Effect.gen(function*() {
      const options = yield* Schema.decodeUnknownEffect(
        ProviderBudgetSettlementHttpOptionsSchema,
        { onExcessProperty: "error" },
      )(untrustedOptions).pipe(
        Effect.mapError(() => settlementHttpError("invalid_configuration")),
      );
      const endpoints = yield* settlementEndpoints(options.baseUrl);
      const fileSystem = yield* FileSystem.FileSystem;
      const client = HttpClient.withScope(yield* HttpClient.HttpClient);

      const report = Effect.fn("agentos.providerBudgetSettlement.report")(
        function*(untrusted: ProviderBudgetSettlementReportV1) {
          const body = yield* Schema.decodeUnknownEffect(
            ProviderBudgetSettlementReportV1Schema,
            { onExcessProperty: "error" },
          )(untrusted).pipe(
            Effect.mapError(() => settlementHttpError("invalid_report")),
          );
          const token = yield* fileSystem.readFileString(options.tokenPath).pipe(
            Effect.mapError(() =>
              settlementHttpError("credential_unavailable")
            ),
            Effect.flatMap(validateProjectedToken),
          );
          let request = HttpClientRequest.post(endpoints.settlement).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
          );
          request = yield* HttpClientRequest.bodyJson(request, body).pipe(
            Effect.mapError(() => settlementHttpError("invalid_report")),
          );
          const responseResult = yield* client.execute(request).pipe(
            Effect.mapError(() => settlementHttpError("request_failed")),
            Effect.flatMap((response) => {
              if (response.status < 200 || response.status >= 300) {
                return settlementStatusError(response.status);
              }
              return readBoundedSettlementReceipt(
                response,
                options.maximumResponseBytes,
              ).pipe(
                Effect.map((receipt) => ({
                  receipt,
                  status: response.status,
                })),
              );
            }),
            Effect.timeoutOrElse({
              duration: options.timeoutMillis,
              orElse: () => settlementHttpError("timeout"),
            }),
            Effect.scoped,
          );
          if (responseResult.receipt.decisionRef !== body.decisionRef) {
            return yield* settlementHttpError(
              "invalid_response",
              responseResult.status,
            );
          }
          return responseResult.receipt;
        },
      );

      const check = Effect.fn("agentos.providerBudgetSettlement.readiness")(
        function*() {
          const token = yield* fileSystem.readFileString(options.tokenPath).pipe(
            Effect.mapError(() =>
              settlementHttpError("credential_unavailable")
            ),
            Effect.flatMap(validateProjectedToken),
          );
          const request = HttpClientRequest.get(endpoints.readiness).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
          );
          const response = yield* client.execute(request).pipe(
            Effect.mapError(() => settlementHttpError("request_failed")),
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? readBoundedSettlementReadiness(
                  response,
                  options.maximumResponseBytes,
                )
                : settlementStatusError(response.status)
            ),
            Effect.timeoutOrElse({
              duration: options.timeoutMillis,
              orElse: () => settlementHttpError("timeout"),
            }),
            Effect.scoped,
          );
          return response;
        },
      )();

      return Context.make(
        ProviderBudgetSettlementReporter,
        ProviderBudgetSettlementReporter.of({ report }),
      ).pipe(
        Context.add(
          ProviderBudgetSettlementReadiness,
          ProviderBudgetSettlementReadiness.of({ check }),
        ),
      );
    }),
  );
}

function settlementEndpoints(baseUrl: string) {
  return Effect.gen(function*() {
    const base = yield* Effect.try({
      try: () => new URL(baseUrl),
      catch: () => settlementHttpError("invalid_configuration"),
    });
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username.length > 0 ||
      base.password.length > 0 ||
      !["", "/"].includes(base.pathname) ||
      base.search.length > 0 ||
      base.hash.length > 0
    ) {
      return yield* settlementHttpError("invalid_configuration");
    }
    return {
      settlement: new URL("/settle", base),
      readiness: new URL("/readyz/settlement", base),
    };
  });
}

function validateProjectedToken(source: string) {
  if (
    source.length === 0 || source.length > 16 * 1_024 ||
    source !== source.trim() || /\s/.test(source)
  ) {
    return Effect.fail(settlementHttpError("credential_unavailable"));
  }
  return Effect.succeed(source);
}

function settlementStatusError(status: number) {
  if (status === 401) {
    return settlementHttpError("unauthorized", status);
  }
  if (status === 403) {
    return settlementHttpError("forbidden", status);
  }
  return settlementHttpError("dependency_unavailable", status);
}

function readBoundedSettlementReceipt(
  response: HttpClientResponse.HttpClientResponse,
  maximumResponseBytes: number,
) {
  const declaredLength = Number(response.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes
  ) {
    return Effect.fail(
      settlementHttpError("response_too_large", response.status),
    );
  }
  return response.stream.pipe(
    Stream.runFoldEffect(emptyBoundedBody, (state, chunk) => {
      const length = state.length + chunk.byteLength;
      return length > maximumResponseBytes
        ? Effect.fail(
          settlementHttpError("response_too_large", response.status),
        )
        : Effect.succeed({
          chunks: [...state.chunks, chunk],
          length,
        });
    }),
    Effect.mapError((error) =>
      error instanceof ProviderBudgetSettlementHttpError
        ? error
        : settlementHttpError("request_failed", response.status)
    ),
    Effect.map(decodeBoundedBody),
    Effect.flatMap((source) =>
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(source).pipe(
        Effect.mapError(() =>
          settlementHttpError("invalid_response", response.status)
        ),
      )
    ),
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        ProviderBudgetSettlementReceiptV1Schema,
        { onExcessProperty: "error" },
      ),
    ),
    Effect.mapError((error) =>
      error instanceof ProviderBudgetSettlementHttpError
        ? error
        : settlementHttpError("invalid_response", response.status)
    ),
  );
}

function readBoundedSettlementReadiness(
  response: HttpClientResponse.HttpClientResponse,
  maximumResponseBytes: number,
) {
  return readBoundedResponseSource(response, maximumResponseBytes).pipe(
    Effect.flatMap((source) =>
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(ProviderBudgetSettlementReadinessV1Schema),
        { onExcessProperty: "error" },
      )(source)
    ),
    Effect.mapError((error) =>
      error instanceof ProviderBudgetSettlementHttpError
        ? error
        : settlementHttpError("invalid_response", response.status)
    ),
    Effect.asVoid,
  );
}

function readBoundedResponseSource(
  response: HttpClientResponse.HttpClientResponse,
  maximumResponseBytes: number,
) {
  const declaredLength = Number(response.headers["content-length"]);
  if (
    Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes
  ) {
    return Effect.fail(
      settlementHttpError("response_too_large", response.status),
    );
  }
  return response.stream.pipe(
    Stream.runFoldEffect(emptyBoundedBody, (state, chunk) => {
      const length = state.length + chunk.byteLength;
      return length > maximumResponseBytes
        ? Effect.fail(
          settlementHttpError("response_too_large", response.status),
        )
        : Effect.succeed({
          chunks: [...state.chunks, chunk],
          length,
        });
    }),
    Effect.mapError((error) =>
      error instanceof ProviderBudgetSettlementHttpError
        ? error
        : settlementHttpError("request_failed", response.status)
    ),
    Effect.map(decodeBoundedBody),
  );
}

interface BoundedBody {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly length: number;
}

function emptyBoundedBody(): BoundedBody {
  return { chunks: [], length: 0 };
}

function decodeBoundedBody(body: BoundedBody) {
  const bytes = new Uint8Array(body.length);
  let offset = 0;
  for (const chunk of body.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function settlementHttpError(
  code: ProviderBudgetSettlementHttpError["code"],
  status: number | null = null,
) {
  return ProviderBudgetSettlementHttpError.make({ code, status });
}
