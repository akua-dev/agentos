import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  A2aCanonicalDeliveryStore,
  A2aCanonicalReferenceVerificationV1Schema,
  A2aCanonicalStoreError,
  A2aDeliveryProjectionV1Schema,
  A2aVerifiedCanonicalReferenceV1Schema,
} from "./a2a-runtime.ts";

const ProjectionRequestSchema = Schema.Struct({
  inboxId: A2aDeliveryProjectionV1Schema.fields.inboxId,
  callerAgentId: A2aVerifiedCanonicalReferenceV1Schema.fields.callerAgentId,
  targetAgentId: A2aVerifiedCanonicalReferenceV1Schema.fields.targetAgentId,
});

export interface A2aDeliveryProjectionRequestV1 {
  readonly inboxId: string;
  readonly callerAgentId: string;
  readonly targetAgentId: string;
}

export class A2aCanonicalDatabaseUnavailable extends Schema.TaggedErrorClass<A2aCanonicalDatabaseUnavailable>()(
  "A2aCanonicalDatabaseUnavailable",
  {
    operation: Schema.Literals(["verify", "wake", "project", "ready"]),
  },
) {}

export class A2aCanonicalDatabase extends Context.Service<
  A2aCanonicalDatabase,
  {
    readonly verify: (
      request: typeof A2aCanonicalReferenceVerificationV1Schema.Type,
    ) => Effect.Effect<ReadonlyArray<unknown>, A2aCanonicalDatabaseUnavailable>;
    readonly wake: (
      inboxId: string,
    ) => Effect.Effect<ReadonlyArray<unknown>, A2aCanonicalDatabaseUnavailable>;
    readonly project: (
      request: A2aDeliveryProjectionRequestV1,
    ) => Effect.Effect<ReadonlyArray<unknown>, A2aCanonicalDatabaseUnavailable>;
    readonly ready: Effect.Effect<boolean>;
  }
>()("agentos/protocol/A2aCanonicalDatabase") {}

export const A2aCanonicalDatabaseSqlLayer = Layer.effect(
  A2aCanonicalDatabase,
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient;
    return A2aCanonicalDatabase.of({
      verify: (request) =>
        sql<Record<string, unknown>>`
          SELECT * FROM agentos.verify_a2a_inbox_reference(
            ${request.inboxId}::uuid,
            ${request.taskId}::uuid,
            ${request.assignmentId}::uuid,
            ${request.callerAgentId}::uuid,
            ${request.targetAgentId}::uuid,
            ${request.speechAct},
            ${request.skillId},
            ${request.subject}
          )
        `.pipe(Effect.mapError(() => databaseError("verify"))),
      wake: (inboxId) =>
        sql<Record<string, unknown>>`
          SELECT * FROM agentos.wake_a2a_inbox_reference(${inboxId}::uuid)
        `.pipe(Effect.mapError(() => databaseError("wake"))),
      project: (request) =>
        sql<Record<string, unknown>>`
          SELECT * FROM agentos.read_a2a_delivery_projection(
            ${request.inboxId}::uuid,
            ${request.callerAgentId}::uuid,
            ${request.targetAgentId}::uuid
          )
        `.pipe(Effect.mapError(() => databaseError("project"))),
      ready: sql<{ readonly ready: boolean }>`
        SELECT
          to_regprocedure(
            'agentos.verify_a2a_inbox_reference(uuid,uuid,uuid,uuid,uuid,text,text,text)'
          ) IS NOT NULL
          AND has_function_privilege(
            current_user,
            'agentos.verify_a2a_inbox_reference(uuid,uuid,uuid,uuid,uuid,text,text,text)',
            'EXECUTE'
          )
          AND has_function_privilege(
            current_user,
            'agentos.wake_a2a_inbox_reference(uuid)',
            'EXECUTE'
          )
          AND has_function_privilege(
            current_user,
            'agentos.read_a2a_delivery_projection(uuid,uuid,uuid)',
            'EXECUTE'
          ) AS ready
      `.pipe(
        Effect.map((rows) => rows.length === 1 && rows[0]?.ready === true),
        Effect.catch(() => Effect.succeed(false)),
      ),
    });
  }),
);

const WakeRowSchema = Schema.Struct({
  version: Schema.Literal(1),
  inboxId: A2aDeliveryProjectionV1Schema.fields.inboxId,
  recovery: Schema.Literal("postgresql_listener_then_herdr_wake"),
});

export const A2aCanonicalDeliveryStorePostgresLayer = Layer.effect(
  A2aCanonicalDeliveryStore,
  Effect.gen(function*() {
    const database = yield* A2aCanonicalDatabase;
    return A2aCanonicalDeliveryStore.of({
      verify: Effect.fn("agentos.a2aStore.verify")(function*(request) {
        const rows = yield* database.verify(request).pipe(Effect.mapError(() => storeError(
          "dependency_unavailable",
          true,
        )));
        return yield* decodeSingle(
          rows,
          A2aVerifiedCanonicalReferenceV1Schema,
        );
      }),
      wake: Effect.fn("agentos.a2aStore.wake")(function*(inboxId) {
        const rows = yield* database.wake(inboxId).pipe(
          Effect.mapError(() => storeError("dependency_unavailable", true)),
        );
        return yield* decodeSingle(rows, WakeRowSchema);
      }),
      project: Effect.fn("agentos.a2aStore.project")(function*(request) {
        const decoded = yield* Schema.decodeUnknownEffect(ProjectionRequestSchema, {
          onExcessProperty: "error",
        })(request).pipe(
          Effect.mapError(() => storeError("reference_denied", false)),
        );
        const rows = yield* database.project(decoded).pipe(
          Effect.mapError(() => storeError("dependency_unavailable", true)),
        );
        return yield* decodeSingle(rows, A2aDeliveryProjectionV1Schema);
      }),
      ready: database.ready,
    });
  }),
);

function decodeSingle<S extends Schema.ConstraintDecoder<unknown>>(
  rows: ReadonlyArray<unknown>,
  schema: S,
): Effect.Effect<S["Type"], A2aCanonicalStoreError, S["DecodingServices"]> {
  if (rows.length !== 1 || rows[0] === undefined) {
    return Effect.fail(storeError("reference_denied", false));
  }
  return Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(
    rows[0],
  ).pipe(Effect.mapError(() => storeError("reference_denied", false)));
}

function databaseError(
  operation: A2aCanonicalDatabaseUnavailable["operation"],
) {
  return A2aCanonicalDatabaseUnavailable.make({ operation });
}

function storeError(
  outcome: A2aCanonicalStoreError["outcome"],
  retryable: boolean,
) {
  return A2aCanonicalStoreError.make({ outcome, retryable });
}
