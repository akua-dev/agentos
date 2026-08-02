import {
  A2aCanonicalDeliveryStore,
  A2aAgentCardV1Schema,
  A2aCanonicalStoreError,
  A2aPolicyAuthorizer,
  A2aPolicyError,
  A2aSpeechActV1Schema,
  A2aTransportTelemetry,
  WorkloadIdentityAuthenticator,
  WorkloadIdentityDependencyUnavailable,
  compileA2aAgentCard,
  compileA2aPublicAgentCard,
  type WorkloadIdentityV1,
} from "@akua-dev/agentos";
import {
  Context,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

const UuidSchema = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
);
const SkillIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[a-z][a-z0-9._-]*@v[1-9][0-9]*$/),
  ),
);
const ReferenceMediaType = "application/vnd.agentos.inbox-reference+json";

export const A2aReferenceDataSchema = Schema.Struct({
  kind: Schema.Literal("agentos.inbox.reference"),
  version: Schema.Literal(1),
  inboxId: UuidSchema,
  taskId: Schema.NullOr(UuidSchema),
  assignmentId: Schema.NullOr(UuidSchema),
  callerAgentId: UuidSchema,
  targetAgentId: UuidSchema,
  speechAct: A2aSpeechActV1Schema,
  skillId: SkillIdSchema,
  subject: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  ),
});
export const SendMessageRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
  method: Schema.Literal("SendMessage"),
  params: Schema.Struct({
    message: Schema.Struct({
      messageId: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
      contextId: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
      role: Schema.Literal("ROLE_USER"),
      parts: Schema.Tuple([
        Schema.Struct({
          data: A2aReferenceDataSchema,
          mediaType: Schema.Literal(ReferenceMediaType),
        }),
      ]),
    }),
    configuration: Schema.Struct({
      acceptedOutputModes: Schema.Tuple([
        Schema.Literal(ReferenceMediaType),
      ]),
      historyLength: Schema.Literal(0),
      returnImmediately: Schema.Literal(true),
    }),
  }),
});
export const GetTaskRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ),
  method: Schema.Literal("GetTask"),
  params: Schema.Struct({
    id: Schema.String.pipe(
      Schema.check(
        Schema.isPattern(/^agentos:delivery:[0-9a-f-]{36}$/),
      ),
    ),
  }),
});
const RpcRequestSchema = Schema.fromJsonString(Schema.Union([
  SendMessageRequestSchema,
  GetTaskRequestSchema,
]));

export const A2aTargetDefinitionV1Schema = Schema.Struct({
  targetAgentId: UuidSchema,
  targetHandle: Schema.String.pipe(
    Schema.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(63),
      Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
    ),
  ),
  description: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  ),
  agentVersion: Schema.String.pipe(
    Schema.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(64),
      Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    ),
  ),
  skillVocabulary: Schema.Array(Schema.Struct({
    id: SkillIdSchema,
    name: Schema.String.pipe(
      Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    ),
    description: Schema.String.pipe(
      Schema.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
    ),
    tags: Schema.Array(Schema.String.pipe(
      Schema.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    )).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
  })).pipe(Schema.check(Schema.isMaxLength(256))),
  reviewedSkillIds: Schema.Array(SkillIdSchema).pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
  profileSkillIds: Schema.Array(SkillIdSchema).pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
  ceilingSkillIds: Schema.Array(SkillIdSchema).pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
});
const AppOptionsSchema = Schema.Struct({
  baseUrl: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s]*)?$/)),
  ),
  maximumBodyBytes: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
  requestTimeoutMillis: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
  targets: Schema.Array(A2aTargetDefinitionV1Schema).pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
});

export const TaskResponseSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.String,
  result: Schema.Struct({
    task: Schema.Struct({
      id: Schema.String,
      contextId: Schema.String,
      status: Schema.Struct({
        state: Schema.Literals([
          "TASK_STATE_SUBMITTED",
          "TASK_STATE_COMPLETED",
        ]),
      }),
    }),
  }),
});
export const ErrorResponseSchema = Schema.Struct({
  error: Schema.Literals([
    "dependency_unavailable",
    "forbidden",
    "invalid_request",
    "not_found",
    "unauthorized",
  ]),
});
export const HealthResponseSchema = Schema.Struct({
  status: Schema.Literals(["alive", "not_ready", "ready"]),
});

export class A2aServiceReadiness extends Context.Service<
  A2aServiceReadiness,
  { readonly check: Effect.Effect<boolean, unknown> }
>()("agentos/a2a-service/A2aServiceReadiness") {}

export type A2aRequestHandler = (
  request: Request,
) => Effect.Effect<Response>;

interface A2aTelemetryContext {
  readonly method: Parameters<
    A2aTransportTelemetry["Service"]["emit"]
  >[0]["method"];
  readonly targetAgentId: string | null;
  readonly skillId: string | null;
  readonly inboxId: string | null;
  readonly taskId: string | null;
  readonly assignmentId: string | null;
}

const EmptyTelemetryContext: A2aTelemetryContext = {
  method: "ExternalAuthorize",
  targetAgentId: null,
  skillId: null,
  inboxId: null,
  taskId: null,
  assignmentId: null,
};

class A2aHttpError extends Schema.TaggedErrorClass<A2aHttpError>()(
  "A2aHttpError",
  {
    outcome: ErrorResponseSchema.fields.error,
    status: Schema.Number,
    retryable: Schema.Boolean,
    method: Schema.Literals([
      "AgentCard",
      "ExternalAuthorize",
      "GetTask",
      "SendMessage",
    ]),
    targetAgentId: Schema.NullOr(UuidSchema),
    skillId: Schema.NullOr(SkillIdSchema),
    inboxId: Schema.NullOr(UuidSchema),
    taskId: Schema.NullOr(UuidSchema),
    assignmentId: Schema.NullOr(UuidSchema),
  },
) {}

export const makeA2aRequestHandler = Effect.fn(
  "agentos.a2aService.makeRequestHandler",
)(function*(untrusted: unknown) {
  const options = yield* Schema.decodeUnknownEffect(AppOptionsSchema, {
    onExcessProperty: "error",
  })(untrusted).pipe(
    Effect.mapError(() => httpError("invalid_request", 400, false)),
  );
  const authenticator = yield* WorkloadIdentityAuthenticator;
  const policy = yield* A2aPolicyAuthorizer;
  const store = yield* A2aCanonicalDeliveryStore;
  const telemetry = yield* A2aTransportTelemetry;
  const serviceReadiness = yield* A2aServiceReadiness;
  const permits = yield* Semaphore.make(128);

  const authenticate = Effect.fn("agentos.a2aService.authenticate")(
    function*(headers: Headers) {
      const bearerToken = bearerTokenFrom(headers);
      if (bearerToken === null) {
        return yield* httpError("unauthorized", 401, false);
      }
      const initial = yield* authenticator.authenticate({
        bearerToken,
        assignmentRequirement: "not_required",
      }).pipe(Effect.mapError(mapIdentityError));
      if (initial.role !== "crewmate") return initial;
      return yield* authenticator.authenticate({
        bearerToken,
        assignmentRequirement: "required",
      }).pipe(Effect.mapError(mapIdentityError));
    },
  );

  const authorizeDelivery = Effect.fn(
    "agentos.a2aService.authorizeDelivery",
  )(function*(identity: WorkloadIdentityV1, request: typeof SendMessageRequestSchema.Type) {
    const reference = request.params.message.parts[0].data;
    const messageId = `agentos:inbox:${reference.inboxId}`;
    const contextId = reference.taskId === null
      ? messageId
      : `agentos:task:${reference.taskId}`;
    if (
      reference.callerAgentId !== identity.agentId ||
      request.id !== messageId ||
      request.params.message.messageId !== messageId ||
      request.params.message.contextId !== contextId
    ) {
      return yield* httpError("forbidden", 403, false, {
        method: "SendMessage",
        targetAgentId: reference.targetAgentId,
        skillId: reference.skillId,
        inboxId: reference.inboxId,
        taskId: reference.taskId,
        assignmentId: reference.assignmentId,
      });
    }
    yield* policy.authorize({
      version: 1,
      identity,
      targetAgentId: reference.targetAgentId,
      skillId: reference.skillId,
      assignmentId: reference.assignmentId,
    }).pipe(Effect.mapError((error) => mapPolicyError(error, reference)));
    return yield* store.verify({
      version: 1,
      inboxId: reference.inboxId,
      taskId: reference.taskId,
      assignmentId: reference.assignmentId,
      callerAgentId: reference.callerAgentId,
      targetAgentId: reference.targetAgentId,
      speechAct: reference.speechAct,
      skillId: reference.skillId,
      subject: reference.subject,
    }).pipe(Effect.mapError((error) => mapStoreError(error, reference)));
  });

  const authorizeTaskRead = Effect.fn(
    "agentos.a2aService.authorizeTaskRead",
  )(function*(
    identity: WorkloadIdentityV1,
    targetAgentId: string,
    request: typeof GetTaskRequestSchema.Type,
  ) {
    const inboxId = request.params.id.slice("agentos:delivery:".length);
    const projection = yield* store.project({
      inboxId,
      callerAgentId: identity.agentId,
      targetAgentId,
    }).pipe(Effect.mapError((error) => mapStoreError(error, {
      inboxId,
      taskId: null,
      assignmentId: null,
      targetAgentId,
      skillId: null,
    })));
    yield* policy.authorize({
      version: 1,
      identity,
      targetAgentId,
      skillId: projection.skillId,
      assignmentId: projection.assignmentId,
    }).pipe(Effect.mapError((error) => mapPolicyError(error, {
      inboxId,
      taskId: null,
      assignmentId: projection.assignmentId,
      targetAgentId,
      skillId: projection.skillId,
    })));
    return projection;
  });

  const route = Effect.fn("agentos.a2aService.route")(function*(
    request: Request,
    telemetryContext: Ref.Ref<A2aTelemetryContext>,
  ) {
    const url = URL.canParse(request.url) ? new URL(request.url) : null;
    if (url === null) return yield* httpError("invalid_request", 400, false);
    if (url.pathname === "/livez") {
      if (request.method !== "GET") {
        return yield* httpError("invalid_request", 405, false);
      }
      return yield* jsonResponse(HealthResponseSchema, { status: "alive" }, 200);
    }
    if (url.pathname === "/readyz") {
      if (request.method !== "GET") {
        return yield* httpError("invalid_request", 405, false);
      }
      const ready = yield* Effect.all([
        policy.ready,
        store.ready,
        serviceReadiness.check,
      ], {
        concurrency: 3,
      }).pipe(
        Effect.map((checks) => checks.every(Boolean)),
        Effect.catch(() => Effect.succeed(false)),
      );
      return yield* jsonResponse(
        HealthResponseSchema,
        { status: ready ? "ready" : "not_ready" },
        ready ? 200 : 503,
      );
    }

    const parsed = parseAgentPath(url.pathname);
    if (
      parsed?.operation === "card" &&
      request.headers.get("authorization") === null
    ) {
      return yield* handlePublicCard(
        request,
        parsed.targetAgentId,
        telemetryContext,
      );
    }

    const identity = yield* authenticate(request.headers);
    if (url.pathname === "/authorize") {
      return yield* authorizeExternal(request, identity, telemetryContext);
    }
    return yield* handleAgentRoute(
      request,
      identity,
      url.pathname,
      false,
      telemetryContext,
    );
  });

  const handlePublicCard = Effect.fn(
    "agentos.a2aService.handlePublicCard",
  )(function*(
    request: Request,
    targetAgentId: string,
    telemetryContext: Ref.Ref<A2aTelemetryContext>,
  ) {
    yield* Ref.set(telemetryContext, {
      ...EmptyTelemetryContext,
      method: "AgentCard",
      targetAgentId,
    });
    if (request.method !== "GET") {
      return yield* httpError("invalid_request", 405, false, {
        method: "AgentCard",
        targetAgentId,
      });
    }
    const target = options.targets.find((candidate) =>
      candidate.targetAgentId === targetAgentId
    );
    if (target === undefined) {
      return yield* httpError("not_found", 404, false, {
        method: "AgentCard",
        targetAgentId,
      });
    }
    const card = yield* compileA2aPublicAgentCard({
      version: 1,
      targetAgentId: target.targetAgentId,
      targetHandle: target.targetHandle,
      description: target.description,
      agentVersion: target.agentVersion,
      baseUrl: options.baseUrl,
    }).pipe(Effect.mapError(() => httpError(
      "not_found",
      404,
      false,
      { method: "AgentCard", targetAgentId },
    )));
    yield* emitTelemetry(telemetry, {
      method: "AgentCard",
      outcome: "accepted",
      retry: false,
      timedOut: false,
      recovery: "not_required",
      targetAgentId,
      skillId: null,
      inboxId: null,
      taskId: null,
      assignmentId: null,
    });
    return yield* jsonResponse(A2aAgentCardV1Schema, card, 200, {
      "a2a-version": "1.0",
      "cache-control": "public, max-age=300",
      "etag": publicCardEtag(targetAgentId, target.agentVersion),
    });
  });

  const handleAgentRoute = Effect.fn(
    "agentos.a2aService.handleAgentRoute",
  )(function*(
    request: Request,
    identity: WorkloadIdentityV1,
    pathname: string,
    externalAuthorization: boolean,
    telemetryContext: Ref.Ref<A2aTelemetryContext>,
  ) {
    const parsed = parseAgentPath(pathname);
    if (parsed === null) {
      return yield* httpError("not_found", 404, false);
    }
    const target = options.targets.find(({ targetAgentId }) =>
      targetAgentId === parsed.targetAgentId
    );
    if (target === undefined) {
      return yield* httpError("not_found", 404, false, {
        targetAgentId: parsed.targetAgentId,
      });
    }
    if (parsed.operation === "card") {
      yield* Ref.set(telemetryContext, {
        ...EmptyTelemetryContext,
        method: "AgentCard",
        targetAgentId: target.targetAgentId,
        assignmentId: identity.assignmentId,
      });
      if (request.method !== "GET") {
        return yield* httpError("invalid_request", 405, false, {
          method: "AgentCard",
          targetAgentId: target.targetAgentId,
        });
      }
      const authorizedSkillIds = yield* policy.filterAuthorizedSkills({
        version: 1,
        identity,
        targetAgentId: target.targetAgentId,
        skillIds: target.skillVocabulary.map(({ id }) => id),
      }).pipe(Effect.mapError((error) => mapPolicyError(error, {
        targetAgentId: target.targetAgentId,
        skillId: null,
        inboxId: null,
        taskId: null,
        assignmentId: null,
      }, "AgentCard")));
      const card = yield* compileA2aAgentCard({
        version: 1,
        targetAgentId: target.targetAgentId,
        targetHandle: target.targetHandle,
        description: target.description,
        agentVersion: target.agentVersion,
        baseUrl: options.baseUrl,
        skillVocabulary: target.skillVocabulary,
        reviewedSkillIds: target.reviewedSkillIds,
        profileSkillIds: target.profileSkillIds,
        ceilingSkillIds: target.ceilingSkillIds,
        authorizedSkillIds,
      }).pipe(Effect.mapError(() => httpError(
        "forbidden",
        403,
        false,
        { method: "AgentCard", targetAgentId: target.targetAgentId },
      )));
      if (externalAuthorization) {
        return yield* Ref.get(telemetryContext).pipe(
          Effect.flatMap((context) =>
            verifiedExternalAuthorizationResponse(
              telemetry,
              context,
              identity.agentId,
            )
          ),
        );
      }
      yield* emitTelemetry(telemetry, {
        method: "AgentCard",
        outcome: "accepted",
        retry: false,
        timedOut: false,
        recovery: "not_required",
        targetAgentId: target.targetAgentId,
        skillId: null,
        inboxId: null,
        taskId: null,
        assignmentId: identity.assignmentId,
      });
      return yield* jsonResponse(A2aAgentCardV1Schema, card, 200, {
        "a2a-version": "1.0",
        "cache-control": "private",
        "etag": cardEtag(identity, target.targetAgentId, authorizedSkillIds),
        "vary": "Authorization",
      });
    }
    if (
      request.method !== "POST" ||
      request.headers.get("a2a-version") !== "1.0"
    ) {
      return yield* httpError("invalid_request", 400, false, {
        targetAgentId: target.targetAgentId,
      });
    }
    const rpc = yield* readRpcRequest(request, options.maximumBodyBytes);
    if (rpc.method === "SendMessage") {
      const reference = rpc.params.message.parts[0].data;
      yield* Ref.set(telemetryContext, {
        method: "SendMessage",
        targetAgentId: reference.targetAgentId,
        skillId: reference.skillId,
        inboxId: reference.inboxId,
        taskId: reference.taskId,
        assignmentId: reference.assignmentId,
      });
      if (reference.targetAgentId !== target.targetAgentId) {
        return yield* httpError("forbidden", 403, false, {
          method: "SendMessage",
          targetAgentId: target.targetAgentId,
          skillId: reference.skillId,
          inboxId: reference.inboxId,
          taskId: reference.taskId,
          assignmentId: reference.assignmentId,
        });
      }
      const verified = yield* authorizeDelivery(identity, rpc);
      if (externalAuthorization) {
        return yield* Ref.get(telemetryContext).pipe(
          Effect.flatMap((context) =>
            verifiedExternalAuthorizationResponse(
              telemetry,
              context,
              identity.agentId,
            )
          ),
        );
      }
      yield* store.wake(verified.inboxId).pipe(
        Effect.mapError((error) => mapStoreError(error, reference)),
      );
      yield* emitTelemetry(telemetry, {
        method: "SendMessage",
        outcome: "accepted",
        retry: false,
        timedOut: false,
        recovery: "postgresql_listener_then_herdr_wake",
        targetAgentId: verified.targetAgentId,
        skillId: verified.skillId,
        inboxId: verified.inboxId,
        taskId: verified.taskId,
        assignmentId: verified.assignmentId,
      });
      return yield* taskResponse(
        rpc.id,
        verified.inboxId,
        verified.a2aContextId,
        "TASK_STATE_SUBMITTED",
      );
    }
    const deliveryInboxId = rpc.params.id.slice(
      "agentos:delivery:".length,
    );
    yield* Ref.set(telemetryContext, {
      ...EmptyTelemetryContext,
      method: "GetTask",
      targetAgentId: target.targetAgentId,
      inboxId: deliveryInboxId,
      assignmentId: identity.assignmentId,
    });
    const projection = yield* authorizeTaskRead(
      identity,
      target.targetAgentId,
      rpc,
    );
    yield* Ref.set(telemetryContext, {
      method: "GetTask",
      targetAgentId: target.targetAgentId,
      skillId: projection.skillId,
      inboxId: projection.inboxId,
      taskId: projection.taskId,
      assignmentId: projection.assignmentId,
    });
    if (externalAuthorization) {
      return yield* Ref.get(telemetryContext).pipe(
        Effect.flatMap((context) =>
          verifiedExternalAuthorizationResponse(
            telemetry,
            context,
            identity.agentId,
          )
        ),
      );
    }
    yield* emitTelemetry(telemetry, {
      method: "GetTask",
      outcome: "accepted",
      retry: false,
      timedOut: false,
      recovery: "not_required",
      targetAgentId: target.targetAgentId,
      skillId: projection.skillId,
      inboxId: projection.inboxId,
      taskId: projection.taskId,
      assignmentId: projection.assignmentId,
    });
    return yield* taskResponse(
      rpc.id,
      projection.inboxId,
      projection.contextId,
      projection.state,
    );
  });

  const authorizeExternal = Effect.fn(
    "agentos.a2aService.authorizeExternal",
  )(function*(
    request: Request,
    identity: WorkloadIdentityV1,
    telemetryContext: Ref.Ref<A2aTelemetryContext>,
  ) {
    const originalMethod = request.headers.get("x-agentos-original-method");
    const originalPath = request.headers.get("x-agentos-original-path");
    if (originalMethod === null || originalPath === null) {
      return yield* httpError("forbidden", 403, false, {
        method: "ExternalAuthorize",
      });
    }
    if (originalMethod !== "GET" && originalMethod !== "POST") {
      return yield* httpError("forbidden", 403, false, {
        method: "ExternalAuthorize",
      });
    }
    const forwarded = originalMethod === "POST"
      ? request
      : new Request(`https://a2a.internal${originalPath}`, {
        method: "GET",
        headers: request.headers,
      });
    return yield* handleAgentRoute(
      forwarded,
      identity,
      originalPath,
      true,
      telemetryContext,
    );
  });

  const handler: A2aRequestHandler = Effect.fn(
    "agentos.a2aService.handleRequest",
  )(function*(request: Request) {
    const telemetryContext = yield* Ref.make(EmptyTelemetryContext);
    return yield* permits.withPermitsIfAvailable(1)(route(
      request,
      telemetryContext,
    ).pipe(
      Effect.timeoutOption(options.requestTimeoutMillis),
    )).pipe(
      Effect.flatMap((permitted) => {
        if (Option.isNone(permitted)) {
          return emitTelemetry(telemetry, unavailableTelemetry(
            EmptyTelemetryContext,
            false,
          )).pipe(
            Effect.andThen(jsonResponse(
              ErrorResponseSchema,
              { error: "dependency_unavailable" },
              503,
            )),
          );
        }
        if (Option.isNone(permitted.value)) {
          return Ref.get(telemetryContext).pipe(
            Effect.flatMap((context) =>
              emitTelemetry(telemetry, unavailableTelemetry(context, true))
            ),
            Effect.andThen(jsonResponse(
              ErrorResponseSchema,
              { error: "dependency_unavailable" },
              503,
            )),
          );
        }
        return Effect.succeed(permitted.value.value);
      }),
      Effect.catch((error) =>
        emitTelemetry(telemetry, telemetryForError(error)).pipe(
          Effect.andThen(jsonResponse(
            ErrorResponseSchema,
            { error: error.outcome },
            error.status,
          )),
        )
      ),
      Effect.catch(() =>
        Effect.succeed(fallbackUnavailableResponse(503))
      ),
    );
  });
  return handler;
});

export function makeA2aRoutesLayer(options: unknown) {
  return Layer.effectDiscard(Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter;
    const handler = yield* makeA2aRequestHandler(options);
    yield* router.add("*", "/*", (request) =>
      HttpServerRequest.toWeb(request).pipe(
        Effect.flatMap(handler),
        Effect.map(HttpServerResponse.fromWeb),
        Effect.catchCause(() =>
          Effect.succeed(HttpServerResponse.fromWeb(
            fallbackUnavailableResponse(503),
          ))
        ),
      ));
  }));
}

function parseAgentPath(pathname: string): {
  readonly targetAgentId: string;
  readonly operation: "card" | "rpc";
} | null {
  const match = /^\/agents\/([0-9a-f-]{36})\/(\.well-known\/agent-card\.json|a2a\/jsonrpc)$/.exec(
    pathname,
  );
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return {
    targetAgentId: match[1],
    operation: match[2] === "a2a/jsonrpc" ? "rpc" : "card",
  };
}

const readRpcRequest = Effect.fn("agentos.a2aService.readRpcRequest")(
  function*(request: Request, maximumBodyBytes: number) {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    const declaredLength = request.headers.get("content-length");
    if (
      !/^application\/json(?:\s*;.*)?$/.test(contentType) ||
      (declaredLength !== null &&
        (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) ||
          Number(declaredLength) > maximumBodyBytes))
    ) {
      return yield* httpError("invalid_request", 400, false);
    }
    const source = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: () => httpError("invalid_request", 400, false),
    });
    if (
      source.length === 0 ||
      new TextEncoder().encode(source).byteLength > maximumBodyBytes
    ) {
      return yield* httpError("invalid_request", 400, false);
    }
    return yield* Schema.decodeUnknownEffect(RpcRequestSchema, {
      onExcessProperty: "error",
    })(source).pipe(
      Effect.mapError(() => httpError("invalid_request", 400, false)),
    );
  },
);

function taskResponse(
  id: string,
  inboxId: string,
  contextId: string,
  state: "TASK_STATE_SUBMITTED" | "TASK_STATE_COMPLETED",
) {
  return jsonResponse(TaskResponseSchema, {
    jsonrpc: "2.0",
    id,
    result: {
      task: {
        id: `agentos:delivery:${inboxId}`,
        contextId,
        status: { state },
      },
    },
  }, 200, { "a2a-version": "1.0" });
}

function verifiedAuthorizationResponse(agentId: string) {
  return new Response(null, {
    status: 200,
    headers: { "x-agentos-a2a-verified-agent-id": agentId },
  });
}

function verifiedExternalAuthorizationResponse(
  telemetry: A2aTransportTelemetry["Service"],
  context: A2aTelemetryContext,
  agentId: string,
) {
  return emitTelemetry(telemetry, {
    ...context,
    method: "ExternalAuthorize",
    outcome: "accepted",
    retry: false,
    timedOut: false,
    recovery: context.inboxId === null
      ? "not_required"
      : "postgresql_listener_then_herdr_wake",
  }).pipe(Effect.as(verifiedAuthorizationResponse(agentId)));
}

function jsonResponse<S extends Schema.Top>(
  schema: S,
  value: S["Type"],
  status: number,
  headers?: Readonly<Record<string, string>>,
) {
  return Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.map((body) => new Response(body, {
      status,
      headers: { "content-type": "application/json", ...headers },
    })),
    Effect.mapError(() => httpError("dependency_unavailable", 503, true)),
  );
}

function bearerTokenFrom(headers: Headers): string | null {
  const authorization = headers.get("authorization")?.trim();
  if (authorization === undefined) return null;
  const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if (token === undefined || token.length > 16 * 1_024) return null;
  return token;
}

function cardEtag(
  identity: WorkloadIdentityV1,
  targetAgentId: string,
  skillIds: ReadonlyArray<string>,
) {
  const fingerprint = [
    identity.fleet,
    identity.agentId,
    identity.domain,
    identity.role,
    identity.assignmentId ?? "unassigned",
    targetAgentId,
    ...skillIds,
  ].join(".").replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return `W/"${fingerprint}"`;
}

function publicCardEtag(targetAgentId: string, agentVersion: string) {
  const version = agentVersion.replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return `W/"public.${targetAgentId}.${version}"`;
}

function mapIdentityError(error: unknown) {
  return error instanceof WorkloadIdentityDependencyUnavailable
    ? httpError("dependency_unavailable", 503, true)
    : httpError("unauthorized", 401, false);
}

function mapPolicyError(
  error: A2aPolicyError,
  reference: {
    readonly targetAgentId: string;
    readonly skillId: string | null;
    readonly inboxId: string | null;
    readonly taskId: string | null;
    readonly assignmentId: string | null;
  },
  method: A2aHttpError["method"] = "SendMessage",
) {
  return error.outcome === "dependency_unavailable"
    ? httpError("dependency_unavailable", 503, true, { ...reference, method })
    : httpError("forbidden", 403, false, { ...reference, method });
}

function mapStoreError(
  error: A2aCanonicalStoreError,
  reference: {
    readonly targetAgentId: string;
    readonly skillId: string | null;
    readonly inboxId: string;
    readonly taskId: string | null;
    readonly assignmentId: string | null;
  },
) {
  return error.outcome === "dependency_unavailable"
    ? httpError("dependency_unavailable", 503, true, reference)
    : httpError("forbidden", 403, false, reference);
}

function httpError(
  outcome: A2aHttpError["outcome"],
  status: number,
  retryable: boolean,
  detail: Partial<{
    readonly method: A2aHttpError["method"];
    readonly targetAgentId: string | null;
    readonly skillId: string | null;
    readonly inboxId: string | null;
    readonly taskId: string | null;
    readonly assignmentId: string | null;
  }> = {},
) {
  return A2aHttpError.make({
    outcome,
    status,
    retryable,
    method: detail.method ?? "ExternalAuthorize",
    targetAgentId: detail.targetAgentId ?? null,
    skillId: detail.skillId ?? null,
    inboxId: detail.inboxId ?? null,
    taskId: detail.taskId ?? null,
    assignmentId: detail.assignmentId ?? null,
  });
}

function telemetryForError(
  error: A2aHttpError,
): Parameters<A2aTransportTelemetry["Service"]["emit"]>[0] {
  const outcome: Parameters<
    A2aTransportTelemetry["Service"]["emit"]
  >[0]["outcome"] =
    error.outcome === "forbidden" || error.outcome === "unauthorized"
      ? "denied"
      : error.outcome;
  return {
    method: error.method,
    outcome,
    retry: error.retryable,
    timedOut: false,
    recovery: error.inboxId === null
      ? "not_required"
      : "postgresql_listener_then_herdr_wake",
    targetAgentId: error.targetAgentId,
    skillId: error.skillId,
    inboxId: error.inboxId,
    taskId: error.taskId,
    assignmentId: error.assignmentId,
  };
}

function unavailableTelemetry(
  context: A2aTelemetryContext,
  timedOut: boolean,
): Parameters<A2aTransportTelemetry["Service"]["emit"]>[0] {
  return {
    ...context,
    outcome: "dependency_unavailable",
    retry: true,
    timedOut,
    recovery: context.inboxId === null
      ? "not_required"
      : "postgresql_listener_then_herdr_wake",
  };
}

function fallbackUnavailableResponse(status: number) {
  return new Response(null, {
    status,
    headers: { "retry-after": "1" },
  });
}

function emitTelemetry(
  telemetry: A2aTransportTelemetry["Service"],
  event: Parameters<A2aTransportTelemetry["Service"]["emit"]>[0],
) {
  return telemetry.emit(event).pipe(Effect.ignore);
}
