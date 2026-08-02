import { assert, describe, it } from "@effect/vitest";
import {
  A2aAgentCardV1Schema,
  A2aCanonicalDeliveryStore,
  A2aCanonicalStoreError,
  A2aPolicyAuthorizer,
  A2aPolicyError,
  A2aPolicyGrantV1Schema,
  A2aTransportTelemetry,
  A2aTransportTelemetryEventV1Schema,
  WorkloadIdentityAuthenticator,
  type WorkloadIdentityV1,
} from "@akua-dev/agentos";
import { Effect, Fiber, Layer, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { HttpRouter } from "effect/unstable/http";

import {
  A2aReferenceDataSchema,
  A2aServiceReadiness,
  GetTaskRequestSchema,
  HealthResponseSchema,
  SendMessageRequestSchema,
  TaskResponseSchema,
  makeA2aRoutesLayer,
  makeA2aRequestHandler,
} from "../src/app.ts";

const CallerAgentId = "11111111-1111-4111-8111-111111111111";
const TargetAgentId = "22222222-2222-4222-8222-222222222222";
const InboxId = "44444444-4444-4444-8444-444444444444";
const TaskId = "55555555-5555-4555-8555-555555555555";
const AssignmentId = "66666666-6666-4666-8666-666666666666";
const Bearer = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDMzNjk2MDB9.signature";

const UnsupportedRpcRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.String,
  method: Schema.Literal("SendStreamingMessage"),
  params: Schema.Struct({}),
});
const ContentBearingRpcRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.String,
  method: Schema.Literal("SendMessage"),
  params: Schema.Struct({
    message: Schema.Struct({
      messageId: Schema.String,
      contextId: Schema.String,
      role: Schema.Literal("ROLE_USER"),
      parts: Schema.Tuple([Schema.Struct({ text: Schema.String })]),
    }),
    configuration: Schema.Struct({
      acceptedOutputModes: Schema.Tuple([
        Schema.Literal("application/vnd.agentos.inbox-reference+json"),
      ]),
      historyLength: Schema.Literal(0),
      returnImmediately: Schema.Literal(true),
    }),
  }),
});
const RejectedRpcRequestSchema = Schema.Union([
  UnsupportedRpcRequestSchema,
  ContentBearingRpcRequestSchema,
]);

const options = {
  baseUrl: "https://agents.example.test/fleet-alpha",
  maximumBodyBytes: 16 * 1_024,
  requestTimeoutMillis: 5_000,
  targets: [{
    targetAgentId: TargetAgentId,
    targetHandle: "platform-mate",
    description: "Owns the reviewed platform domain",
    agentVersion: "2026.08.02",
    skillVocabulary: [{
      id: "repository.implementation@v1",
      name: "Repository implementation",
      description: "Implements reviewed repository changes",
      tags: ["repository", "implementation"],
    }, {
      id: "production.deployment@v1",
      name: "Production deployment",
      description: "Deploys reviewed production revisions",
      tags: ["production", "deployment"],
    }],
    reviewedSkillIds: [
      "repository.implementation@v1",
      "production.deployment@v1",
    ],
    profileSkillIds: [
      "repository.implementation@v1",
      "production.deployment@v1",
    ],
    ceilingSkillIds: ["repository.implementation@v1"],
  }],
};

const identity: WorkloadIdentityV1 = {
  schemaVersion: 1,
  agentId: CallerAgentId,
  role: "second_mate",
  fleet: "fleet-alpha",
  domain: "platform",
  assignmentId: null,
  kubernetesNamespace: "agentos-platform",
  kubernetesPod: "platform-mate-0",
  podUid: "77777777-7777-4777-8777-777777777777",
  serviceAccountName: "platform-mate",
  serviceAccountUid: "88888888-8888-4888-8888-888888888888",
};

function referenceData(): typeof A2aReferenceDataSchema.Type {
  return {
    kind: "agentos.inbox.reference",
    version: 1,
    inboxId: InboxId,
    taskId: TaskId,
    assignmentId: AssignmentId,
    callerAgentId: CallerAgentId,
    targetAgentId: TargetAgentId,
    speechAct: "request",
    skillId: "repository.implementation@v1",
    subject: "Implement the reviewed repository change",
  };
}

function sendMessageBody(): typeof SendMessageRequestSchema.Type {
  return {
    jsonrpc: "2.0",
    id: `agentos:inbox:${InboxId}`,
    method: "SendMessage",
    params: {
      message: {
        messageId: `agentos:inbox:${InboxId}`,
        contextId: `agentos:task:${TaskId}`,
        role: "ROLE_USER",
        parts: [{
          data: referenceData(),
          mediaType: "application/vnd.agentos.inbox-reference+json",
        }],
      },
      configuration: {
        acceptedOutputModes: [
          "application/vnd.agentos.inbox-reference+json",
        ],
        historyLength: 0,
        returnImmediately: true,
      },
    },
  };
}

const makeFixture = Effect.fn("test.a2a.makeFixture")(function*(input?: {
  readonly authorized?: boolean;
  readonly ready?: boolean;
  readonly identityReady?: boolean;
  readonly authorizationDelayMillis?: number;
  readonly requestTimeoutMillis?: number;
  readonly storeFailure?: "dependency_unavailable" | "reference_denied";
}) {
  const wakeCount = yield* Ref.make(0);
  const events = yield* Ref.make<ReadonlyArray<
    typeof A2aTransportTelemetryEventV1Schema.Type
  >>([]);
  const authorized = input?.authorized ?? true;
  const ready = input?.ready ?? true;

  const dependencies = Layer.mergeAll(
    Layer.succeed(WorkloadIdentityAuthenticator, {
      authenticate: () => Effect.succeed(identity),
      invalidate: () => Effect.void,
    }),
    Layer.succeed(A2aPolicyAuthorizer, {
      authorize: (request) => {
        const grant: typeof A2aPolicyGrantV1Schema.Type = {
            version: 1,
            callerAgentId: request.identity.agentId,
            targetAgentId: request.targetAgentId,
            skillId: request.skillId,
            profileId: "platform-builder",
            profileVersion: 3,
            ceilingId: "ceiling_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ceilingRevision: 7,
          };
        const decision = authorized
          ? Effect.succeed(grant)
          : Effect.fail(A2aPolicyError.make({
            outcome: "denied",
            retryable: false,
          }));
        return input?.authorizationDelayMillis === undefined
          ? decision
          : Effect.sleep(input.authorizationDelayMillis).pipe(
            Effect.andThen(decision),
          );
      },
      filterAuthorizedSkills: (request) =>
        Effect.succeed(
          authorized
            ? request.skillIds.filter((skillId) =>
              skillId === "repository.implementation@v1"
            )
            : [],
        ),
      ready: Effect.succeed(ready),
    }),
    Layer.succeed(A2aCanonicalDeliveryStore, {
      verify: (request) =>
        input?.storeFailure === "dependency_unavailable"
          ? Effect.fail(A2aCanonicalStoreError.make({
            outcome: "dependency_unavailable",
            retryable: true,
          }))
          : input?.storeFailure === "reference_denied"
          ? Effect.fail(A2aCanonicalStoreError.make({
            outcome: "reference_denied",
            retryable: false,
          }))
          : Effect.succeed({
            version: 1,
            inboxId: request.inboxId,
            taskId: request.taskId,
            assignmentId: request.assignmentId,
            callerAgentId: request.callerAgentId,
            targetAgentId: request.targetAgentId,
            speechAct: request.speechAct,
            skillId: request.skillId,
            subject: request.subject,
            canonicalInbox: "unread",
            a2aContextId: `agentos:task:${TaskId}`,
          }),
      wake: (inboxId) =>
        Ref.updateAndGet(wakeCount, (count) => count + 1).pipe(
          Effect.map(() => ({
            version: 1,
            inboxId,
            recovery: "postgresql_listener_then_herdr_wake",
          })),
        ),
      project: ({ inboxId }) =>
        Effect.succeed({
          version: 1,
          inboxId,
          contextId: `agentos:task:${TaskId}`,
          state: "TASK_STATE_SUBMITTED",
          canonicalInbox: "unread",
          skillId: "repository.implementation@v1",
          taskId: TaskId,
          assignmentId: AssignmentId,
        }),
      ready: Effect.succeed(ready),
    }),
    Layer.succeed(A2aServiceReadiness, {
      check: Effect.succeed(input?.identityReady ?? true),
    }),
    Layer.succeed(A2aTransportTelemetry, {
      emit: (event) => Ref.update(events, (all) => [...all, event]),
    }),
  );
  const handler = yield* makeA2aRequestHandler({
    ...options,
    requestTimeoutMillis: input?.requestTimeoutMillis ??
      options.requestTimeoutMillis,
  }).pipe(
    Effect.provide(dependencies),
  );
  return { events, handler, wakeCount };
});

function request(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${Bearer}`);
  return new Request(`https://a2a.internal${path}`, { ...init, headers });
}

function decodeJson<S extends Schema.Top>(schema: S, response: Response) {
  return Effect.tryPromise(() => response.text()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema), {
      onExcessProperty: "error",
    })),
  );
}

describe("AgentOS PostgreSQL-first A2A service", () => {
  it.effect("serves the Effect request core through an Effect Platform router", () =>
    Effect.acquireUseRelease(
      Effect.succeed(HttpRouter.toWebHandler(
        makeA2aRoutesLayer(options).pipe(
          Layer.provide(Layer.mergeAll(
            Layer.succeed(WorkloadIdentityAuthenticator, {
              authenticate: () => Effect.succeed(identity),
              invalidate: () => Effect.void,
            }),
            Layer.succeed(A2aPolicyAuthorizer, {
              authorize: () => Effect.die("unused"),
              filterAuthorizedSkills: () => Effect.die("unused"),
              ready: Effect.succeed(true),
            }),
            Layer.succeed(A2aCanonicalDeliveryStore, {
              verify: () => Effect.die("unused"),
              wake: () => Effect.die("unused"),
              project: () => Effect.die("unused"),
              ready: Effect.succeed(true),
            }),
            Layer.succeed(A2aServiceReadiness, {
              check: Effect.succeed(true),
            }),
            A2aTransportTelemetry.noop,
          )),
        ),
        { disableLogger: true },
      )),
      (web) => Effect.tryPromise(() =>
        web.handler(new Request("https://a2a.internal/livez"))
      ),
      (web) => Effect.promise(web.dispose),
    ).pipe(
      Effect.tap((response) =>
        Effect.sync(() => assert.strictEqual(response.status, 200))
      ),
    ));

  it.effect("publishes no operational skills and authenticates the filtered extended card", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture();
      const publicResponse = yield* fixture.handler(new Request(
        `https://a2a.internal/agents/${TargetAgentId}/.well-known/agent-card.json`,
      ));
      assert.strictEqual(publicResponse.status, 200);
      assert.strictEqual(publicResponse.headers.get("a2a-version"), "1.0");
      assert.strictEqual(
        publicResponse.headers.get("cache-control"),
        "public, max-age=300",
      );
      assert.deepStrictEqual(
        yield* decodeJson(A2aAgentCardV1Schema, publicResponse),
        {
        name: "platform-mate",
        description: "Owns the reviewed platform domain",
        supportedInterfaces: [{
          url:
            `https://agents.example.test/fleet-alpha/agents/${TargetAgentId}/a2a/jsonrpc`,
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        }],
        version: "2026.08.02",
        capabilities: {
          streaming: false,
          pushNotifications: false,
          extendedAgentCard: true,
        },
        securitySchemes: {
          projectedServiceAccountBearer: {
            httpAuthSecurityScheme: {
              description: "Kubelet-rotated projected Agent ServiceAccount identity",
              scheme: "Bearer",
              bearerFormat: "Kubernetes ServiceAccount token",
            },
          },
        },
        securityRequirements: [{
          schemes: { projectedServiceAccountBearer: [] },
        }],
        defaultInputModes: [
          "application/vnd.agentos.inbox-reference+json",
        ],
        defaultOutputModes: [
          "application/vnd.agentos.inbox-reference+json",
        ],
        skills: [],
        },
      );

      const response = yield* fixture.handler(request(
        `/agents/${TargetAgentId}/.well-known/agent-card.json`,
      ));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("a2a-version"), "1.0");
      assert.strictEqual(response.headers.get("cache-control"), "private");
      assert.strictEqual(response.headers.get("vary"), "Authorization");
      const body = yield* decodeJson(A2aAgentCardV1Schema, response);
      assert.deepStrictEqual(body, {
        name: "platform-mate",
        description: "Owns the reviewed platform domain",
        supportedInterfaces: [{
          url:
            `https://agents.example.test/fleet-alpha/agents/${TargetAgentId}/a2a/jsonrpc`,
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        }],
        version: "2026.08.02",
        capabilities: {
          streaming: false,
          pushNotifications: false,
          extendedAgentCard: true,
        },
        securitySchemes: {
          projectedServiceAccountBearer: {
            httpAuthSecurityScheme: {
              description: "Kubelet-rotated projected Agent ServiceAccount identity",
              scheme: "Bearer",
              bearerFormat: "Kubernetes ServiceAccount token",
            },
          },
        },
        securityRequirements: [{
          schemes: { projectedServiceAccountBearer: [] },
        }],
        defaultInputModes: [
          "application/vnd.agentos.inbox-reference+json",
        ],
        defaultOutputModes: [
          "application/vnd.agentos.inbox-reference+json",
        ],
        skills: [{
          id: "repository.implementation@v1",
          name: "Repository implementation",
          description: "Implements reviewed repository changes",
          tags: ["repository", "implementation"],
          inputModes: ["application/vnd.agentos.inbox-reference+json"],
          outputModes: ["application/vnd.agentos.inbox-reference+json"],
          securityRequirements: [{
            schemes: { projectedServiceAccountBearer: [] },
          }],
        }],
      });
    }));

  it.effect("verifies the committed reference then emits one best-effort wake", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture();
      const response = yield* fixture.handler(request(
        `/agents/${TargetAgentId}/a2a/jsonrpc`,
        {
          method: "POST",
          headers: {
            "a2a-version": "1.0",
            "content-type": "application/json",
          },
          body: yield* Schema.encodeEffect(
            Schema.fromJsonString(SendMessageRequestSchema),
          )(
            sendMessageBody(),
          ),
        },
      ));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("a2a-version"), "1.0");
      assert.deepStrictEqual(yield* decodeJson(TaskResponseSchema, response), {
        jsonrpc: "2.0",
        id: `agentos:inbox:${InboxId}`,
        result: {
          task: {
            id: `agentos:delivery:${InboxId}`,
            contextId: `agentos:task:${TaskId}`,
            status: { state: "TASK_STATE_SUBMITTED" },
          },
        },
      });
      assert.strictEqual(yield* Ref.get(fixture.wakeCount), 1);
      assert.deepStrictEqual(yield* Ref.get(fixture.events), [{
        method: "SendMessage",
        outcome: "accepted",
        retry: false,
        timedOut: false,
        recovery: "postgresql_listener_then_herdr_wake",
        targetAgentId: TargetAgentId,
        skillId: "repository.implementation@v1",
        inboxId: InboxId,
        taskId: TaskId,
        assignmentId: AssignmentId,
      }]);
    }));

  it.effect("allows replay to repeat only the wake for the same canonical Inbox", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture();
      const body = yield* Schema.encodeEffect(
        Schema.fromJsonString(SendMessageRequestSchema),
      )(sendMessageBody());
      for (const attempt of [1, 2]) {
        const response = yield* fixture.handler(request(
          `/agents/${TargetAgentId}/a2a/jsonrpc`,
          {
            method: "POST",
            headers: {
              "a2a-version": "1.0",
              "content-type": "application/json",
              "x-test-attempt": String(attempt),
            },
            body,
          },
        ));
        assert.strictEqual(response.status, 200);
      }
      assert.strictEqual(yield* Ref.get(fixture.wakeCount), 2);
    }));

  it.effect("derives GetTask from the canonical receipt without exposing history", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture();
      const body = yield* Schema.encodeEffect(
        Schema.fromJsonString(GetTaskRequestSchema),
      )({
        jsonrpc: "2.0",
        id: "delivery-status-1",
        method: "GetTask",
        params: { id: `agentos:delivery:${InboxId}` },
      });
      const response = yield* fixture.handler(request(
        `/agents/${TargetAgentId}/a2a/jsonrpc`,
        {
          method: "POST",
          headers: {
            "a2a-version": "1.0",
            "content-type": "application/json",
          },
          body,
        },
      ));
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* decodeJson(TaskResponseSchema, response), {
        jsonrpc: "2.0",
        id: "delivery-status-1",
        result: {
          task: {
            id: `agentos:delivery:${InboxId}`,
            contextId: `agentos:task:${TaskId}`,
            status: { state: "TASK_STATE_SUBMITTED" },
          },
        },
      });
      assert.deepStrictEqual(yield* Ref.get(fixture.events), [{
        method: "GetTask",
        outcome: "accepted",
        retry: false,
        timedOut: false,
        recovery: "not_required",
        targetAgentId: TargetAgentId,
        skillId: "repository.implementation@v1",
        inboxId: InboxId,
        taskId: TaskId,
        assignmentId: AssignmentId,
      }]);
    }));

  it.effect("fails closed for policy, canonical-reference, and dependency failures", () =>
    Effect.gen(function*() {
      const body = yield* Schema.encodeEffect(
        Schema.fromJsonString(SendMessageRequestSchema),
      )(sendMessageBody());
      for (const scenario of [{
        fixture: yield* makeFixture({ authorized: false }),
        status: 403,
      }, {
        fixture: yield* makeFixture({ storeFailure: "reference_denied" }),
        status: 403,
      }, {
        fixture: yield* makeFixture({
          storeFailure: "dependency_unavailable",
        }),
        status: 503,
      }]) {
        const response = yield* scenario.fixture.handler(request(
          `/agents/${TargetAgentId}/a2a/jsonrpc`,
          {
            method: "POST",
            headers: {
              "a2a-version": "1.0",
              "content-type": "application/json",
            },
            body,
          },
        ));
        assert.strictEqual(response.status, scenario.status);
        assert.strictEqual(yield* Ref.get(scenario.fixture.wakeCount), 0);
      }
    }));

  it.effect("rejects unadvertised operations and content-bearing envelopes", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture();
      for (const untrustedRpc of [{
        jsonrpc: "2.0",
        id: "unsupported-1",
        method: "SendStreamingMessage",
        params: {},
      }, {
        ...sendMessageBody(),
        params: {
          ...sendMessageBody().params,
          message: {
            ...sendMessageBody().params.message,
            parts: [{ text: "prompt content must not cross A2A" }],
          },
        },
      }]) {
        const rpc = yield* Schema.decodeUnknownEffect(RejectedRpcRequestSchema, {
          onExcessProperty: "error",
        })(untrustedRpc);
        const body = yield* Schema.encodeEffect(
          Schema.fromJsonString(RejectedRpcRequestSchema),
        )(rpc);
        const response = yield* fixture.handler(request(
          `/agents/${TargetAgentId}/a2a/jsonrpc`,
          {
            method: "POST",
            headers: {
              "a2a-version": "1.0",
              "content-type": "application/json",
            },
            body,
          },
        ));
        assert.strictEqual(response.status, 400);
        assert.strictEqual(yield* Ref.get(fixture.wakeCount), 0);
      }
    }));

  it.effect("performs the same full check at agentgateway external authorization without waking", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture();
      const body = yield* Schema.encodeEffect(
        Schema.fromJsonString(SendMessageRequestSchema),
      )(sendMessageBody());
      const response = yield* fixture.handler(request("/authorize", {
        method: "POST",
        headers: {
          "a2a-version": "1.0",
          "content-type": "application/json",
          "x-agentos-original-method": "POST",
          "x-agentos-original-path":
            `/agents/${TargetAgentId}/a2a/jsonrpc`,
        },
        body,
      }));
      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        response.headers.get("x-agentos-a2a-verified-agent-id"),
        CallerAgentId,
      );
      assert.strictEqual(yield* Ref.get(fixture.wakeCount), 0);
      assert.deepStrictEqual(yield* Ref.get(fixture.events), [{
        method: "ExternalAuthorize",
        outcome: "accepted",
        retry: false,
        timedOut: false,
        recovery: "postgresql_listener_then_herdr_wake",
        targetAgentId: TargetAgentId,
        skillId: "repository.implementation@v1",
        inboxId: InboxId,
        taskId: TaskId,
        assignmentId: AssignmentId,
      }]);
    }));

  it.effect("fails readiness closed without policy and PostgreSQL dependencies", () =>
    Effect.gen(function*() {
      const live = yield* makeFixture();
      const liveResponse = yield* live.handler(
        new Request("https://a2a.internal/livez"),
      );
      assert.strictEqual(liveResponse.status, 200);
      assert.deepStrictEqual(yield* decodeJson(HealthResponseSchema, liveResponse), {
        status: "alive",
      });

      const ready = yield* makeFixture();
      const readyResponse = yield* ready.handler(
        new Request("https://a2a.internal/readyz"),
      );
      assert.strictEqual(readyResponse.status, 200);
      assert.deepStrictEqual(yield* decodeJson(HealthResponseSchema, readyResponse), {
        status: "ready",
      });

      const unavailable = yield* makeFixture({ ready: false });
      const unavailableResponse = yield* unavailable.handler(
        new Request("https://a2a.internal/readyz"),
      );
      assert.strictEqual(unavailableResponse.status, 503);
      assert.deepStrictEqual(
        yield* decodeJson(HealthResponseSchema, unavailableResponse),
        {
        status: "not_ready",
        },
      );

      const identityUnavailable = yield* makeFixture({
        identityReady: false,
      });
      const identityUnavailableResponse = yield* identityUnavailable.handler(
        new Request("https://a2a.internal/readyz"),
      );
      assert.strictEqual(identityUnavailableResponse.status, 503);

      const wrongMethod = yield* live.handler(new Request(
        "https://a2a.internal/livez",
        { method: "POST" },
      ));
      assert.strictEqual(wrongMethod.status, 405);
    }));

  it.effect("records timeout distinctly and never wakes canonical state", () =>
    Effect.gen(function*() {
      const fixture = yield* makeFixture({
        authorizationDelayMillis: 1_000,
        requestTimeoutMillis: 100,
      });
      const body = yield* Schema.encodeEffect(
        Schema.fromJsonString(SendMessageRequestSchema),
      )(sendMessageBody());
      const fiber = yield* Effect.forkChild(fixture.handler(request(
        `/agents/${TargetAgentId}/a2a/jsonrpc`,
        {
          method: "POST",
          headers: {
            "a2a-version": "1.0",
            "content-type": "application/json",
          },
          body,
        },
      )), { startImmediately: true });
      yield* TestClock.adjust(100);
      const response = yield* Fiber.join(fiber);
      assert.strictEqual(response.status, 503);
      assert.strictEqual(yield* Ref.get(fixture.wakeCount), 0);
      assert.deepStrictEqual(yield* Ref.get(fixture.events), [{
        method: "SendMessage",
        outcome: "dependency_unavailable",
        retry: true,
        timedOut: true,
        recovery: "postgresql_listener_then_herdr_wake",
        targetAgentId: TargetAgentId,
        skillId: "repository.implementation@v1",
        inboxId: InboxId,
        taskId: TaskId,
        assignmentId: AssignmentId,
      }]);
    }));
});
