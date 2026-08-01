import { createHash } from "node:crypto";
import {
  Clock,
  Context,
  Effect,
  Encoding,
  Layer,
  Ref,
  Schema,
} from "effect";

const Uuid = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
);
const KubernetesName = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);
const KubernetesUid = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[0-9A-Za-z](?:[0-9A-Za-z_.:-]*[0-9A-Za-z])?$/),
  ),
);
const EpochMillis = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const JwtExpirationPayload = Schema.Struct({
  exp: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)),
    ),
  ),
});

export const AGENTOS_EGRESS_TOKEN_AUDIENCE = "agentos-egress-authz";
export const AGENTOS_EGRESS_TOKEN_MOUNT_PATH =
  "/var/run/secrets/agentos-egress";
export const AGENTOS_EGRESS_TOKEN_PATH =
  `${AGENTOS_EGRESS_TOKEN_MOUNT_PATH}/token`;
export const AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS = 600;
export const AGENTOS_IDENTITY_POSITIVE_CACHE_TTL_MILLIS = 15_000;
export const AGENTOS_IDENTITY_REVOCATION_SLO_MILLIS = 60_000;

export const KubernetesReviewedIdentityV1Schema = Schema.Struct({
  authenticated: Schema.Boolean,
  audiences: Schema.Array(Schema.String),
  username: Schema.NullOr(Schema.String),
  serviceAccountUid: Schema.NullOr(KubernetesUid),
  podNames: Schema.Array(KubernetesName),
  podUids: Schema.Array(KubernetesUid),
});

export const KubernetesPodIdentityV1Schema = Schema.Struct({
  namespace: KubernetesName,
  name: KubernetesName,
  uid: KubernetesUid,
  serviceAccountName: KubernetesName,
  phase: Schema.Literals([
    "Pending",
    "Running",
    "Succeeded",
    "Failed",
    "Unknown",
  ]),
  deletionTimestampMillis: Schema.NullOr(EpochMillis),
});

export const KubernetesServiceAccountIdentityV1Schema = Schema.Struct({
  namespace: KubernetesName,
  name: KubernetesName,
  uid: KubernetesUid,
  deletionTimestampMillis: Schema.NullOr(EpochMillis),
});

export const AgentOSWorkloadAgentV1Schema = Schema.Struct({
  agentId: Uuid,
  role: Schema.Literals(["first_mate", "second_mate", "crewmate"]),
  fleet: KubernetesName,
  domain: KubernetesName,
  kubernetesNamespace: KubernetesName,
  kubernetesPod: KubernetesName,
  lifecycleStatus: Schema.String,
  retiredAtMillis: Schema.NullOr(EpochMillis),
});

export const AgentOSWorkloadAssignmentV1Schema = Schema.Struct({
  assignmentId: Uuid,
  agentId: Uuid,
  status: Schema.String,
  endedAtMillis: Schema.NullOr(EpochMillis),
});

export const WorkloadIdentityV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  agentId: Uuid,
  role: AgentOSWorkloadAgentV1Schema.fields.role,
  fleet: KubernetesName,
  domain: KubernetesName,
  assignmentId: Schema.NullOr(Uuid),
  kubernetesNamespace: KubernetesName,
  kubernetesPod: KubernetesName,
  podUid: KubernetesUid,
  serviceAccountName: KubernetesName,
  serviceAccountUid: KubernetesUid,
});

export const WorkloadIdentityInvalidationV1Schema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({ kind: Schema.Literal("pod"), podUid: KubernetesUid }),
  Schema.Struct({
    kind: Schema.Literal("service_account"),
    serviceAccountUid: KubernetesUid,
  }),
  Schema.Struct({ kind: Schema.Literal("agent"), agentId: Uuid }),
  Schema.Struct({
    kind: Schema.Literal("assignment"),
    assignmentId: Uuid,
  }),
]);

const WorkloadAuthenticationErrorCode = Schema.Literals([
  "invalid_token",
  "token_expired",
  "token_review_rejected",
  "wrong_audience",
  "invalid_service_account_username",
  "service_account_uid_missing",
  "bound_pod_missing",
  "bound_pod_ambiguous",
  "pod_not_found",
  "pod_uid_mismatch",
  "pod_deleting",
  "pod_not_running",
  "service_account_not_found",
  "service_account_uid_mismatch",
  "service_account_deleting",
  "pod_service_account_mismatch",
]);

export class WorkloadAuthenticationError extends Schema.TaggedErrorClass<WorkloadAuthenticationError>()(
  "WorkloadAuthenticationError",
  { code: WorkloadAuthenticationErrorCode },
) {}

const WorkloadIdentityResolutionErrorCode = Schema.Literals([
  "agent_not_found",
  "agent_ambiguous",
  "agent_inactive",
  "agent_locator_mismatch",
  "assignment_not_found",
  "assignment_ambiguous",
  "assignment_inactive",
]);

export class WorkloadIdentityResolutionError extends Schema.TaggedErrorClass<WorkloadIdentityResolutionError>()(
  "WorkloadIdentityResolutionError",
  { code: WorkloadIdentityResolutionErrorCode },
) {}

const WorkloadAuthorizationErrorCode = Schema.Literals([
  "assignment_owner_mismatch",
  "identity_subject_mismatch",
]);

export class WorkloadAuthorizationError extends Schema.TaggedErrorClass<WorkloadAuthorizationError>()(
  "WorkloadAuthorizationError",
  { code: WorkloadAuthorizationErrorCode },
) {}

export class WorkloadIdentityDependencyUnavailable extends Schema.TaggedErrorClass<WorkloadIdentityDependencyUnavailable>()(
  "WorkloadIdentityDependencyUnavailable",
  {
    dependency: Schema.Literals([
      "token_review",
      "kubernetes",
      "identity_store",
    ]),
    operation: Schema.Literals([
      "configure_client",
      "review",
      "get_pod",
      "get_service_account",
      "find_agent",
      "find_assignment",
    ]),
    code: Schema.optional(Schema.Literals([
      "credential_unavailable",
      "trust_unavailable",
      "invalid_configuration",
      "network_failure",
      "timeout",
      "unexpected_status",
      "response_too_large",
      "invalid_response",
      "database_unavailable",
    ])),
    status: Schema.optional(Schema.NullOr(Schema.Number)),
  },
) {}

export class WorkloadPolicyDenied extends Schema.TaggedErrorClass<WorkloadPolicyDenied>()(
  "WorkloadPolicyDenied",
  { code: Schema.Literal("policy_denied") },
) {}

export type KubernetesReviewedIdentityV1 =
  typeof KubernetesReviewedIdentityV1Schema.Type;
export type KubernetesPodIdentityV1 =
  typeof KubernetesPodIdentityV1Schema.Type;
export type KubernetesServiceAccountIdentityV1 =
  typeof KubernetesServiceAccountIdentityV1Schema.Type;
export type AgentOSWorkloadAgentV1 =
  typeof AgentOSWorkloadAgentV1Schema.Type;
export type AgentOSWorkloadAssignmentV1 =
  typeof AgentOSWorkloadAssignmentV1Schema.Type;
export type WorkloadIdentityV1 = typeof WorkloadIdentityV1Schema.Type;
export type WorkloadIdentityInvalidationV1 =
  typeof WorkloadIdentityInvalidationV1Schema.Type;

export type WorkloadIdentityError =
  | WorkloadAuthenticationError
  | WorkloadIdentityResolutionError
  | WorkloadAuthorizationError
  | WorkloadIdentityDependencyUnavailable
  | WorkloadPolicyDenied;

export interface KubernetesTokenReviewRequest {
  readonly token: string;
  readonly audiences: ReadonlyArray<string>;
}

export interface KubernetesObjectReference {
  readonly namespace: string;
  readonly name: string;
}

export interface AgentOSWorkloadReference {
  readonly kubernetesNamespace: string;
  readonly kubernetesPod: string;
}

export interface WorkloadIdentityAuthenticationRequest {
  readonly bearerToken: string;
  readonly assignmentRequirement: "not_required" | "required";
}

export class KubernetesTokenReviewer extends Context.Service<
  KubernetesTokenReviewer,
  {
    readonly review: (
      request: KubernetesTokenReviewRequest,
    ) => Effect.Effect<
      KubernetesReviewedIdentityV1,
      WorkloadIdentityDependencyUnavailable
    >;
  }
>()("agentos/access/KubernetesTokenReviewer") {}

export class KubernetesWorkloadIdentityLookup extends Context.Service<
  KubernetesWorkloadIdentityLookup,
  {
    readonly getPod: (
      reference: KubernetesObjectReference,
    ) => Effect.Effect<
      KubernetesPodIdentityV1 | null,
      WorkloadIdentityDependencyUnavailable
    >;
    readonly getServiceAccount: (
      reference: KubernetesObjectReference,
    ) => Effect.Effect<
      KubernetesServiceAccountIdentityV1 | null,
      WorkloadIdentityDependencyUnavailable
    >;
  }
>()("agentos/access/KubernetesWorkloadIdentityLookup") {}

export class AgentOSWorkloadIdentityStore extends Context.Service<
  AgentOSWorkloadIdentityStore,
  {
    readonly findAgentsByWorkload: (
      reference: AgentOSWorkloadReference,
    ) => Effect.Effect<
      ReadonlyArray<AgentOSWorkloadAgentV1>,
      WorkloadIdentityDependencyUnavailable
    >;
    readonly findAssignmentsByAgent: (
      agentId: string,
    ) => Effect.Effect<
      ReadonlyArray<AgentOSWorkloadAssignmentV1>,
      WorkloadIdentityDependencyUnavailable
    >;
  }
>()("agentos/access/AgentOSWorkloadIdentityStore") {}

interface PositiveCacheEntry {
  readonly expiresAtMillis: number;
  readonly identity: WorkloadIdentityV1;
}

export class WorkloadIdentityAuthenticator extends Context.Service<
  WorkloadIdentityAuthenticator,
  {
    readonly authenticate: (
      request: WorkloadIdentityAuthenticationRequest,
    ) => Effect.Effect<WorkloadIdentityV1, WorkloadIdentityError>;
    readonly invalidate: (
      invalidation: WorkloadIdentityInvalidationV1,
    ) => Effect.Effect<void>;
  }
>()("agentos/access/WorkloadIdentityAuthenticator") {
  static readonly layer = Layer.effect(
    WorkloadIdentityAuthenticator,
    Effect.gen(function*() {
      const tokenReviewer = yield* KubernetesTokenReviewer;
      const kubernetes = yield* KubernetesWorkloadIdentityLookup;
      const identityStore = yield* AgentOSWorkloadIdentityStore;
      const cache = yield* Ref.make<ReadonlyMap<string, PositiveCacheEntry>>(
        new Map(),
      );

      const authenticateEffect = Effect.fn(
        "WorkloadIdentityAuthenticator.authenticate",
      )(function*(request: WorkloadIdentityAuthenticationRequest) {
        if (tokenPayloadSegment(request.bearerToken) === null) {
          return yield* authenticationError("invalid_token");
        }
        const now = yield* Clock.currentTimeMillis;
        const cacheKey = positiveCacheKey(request);
        const cached = yield* takeLiveCacheEntry(cache, cacheKey, now);
        if (cached !== undefined) {
          yield* annotateIdentitySpan(cached.identity, true);
          return cached.identity;
        }

        const reviewed = yield* tokenReviewer.review({
          token: request.bearerToken,
          audiences: [AGENTOS_EGRESS_TOKEN_AUDIENCE],
        });
        const binding = yield* reviewedBinding(reviewed);
        const tokenExpiresAtMillis = yield* tokenExpirationMillis(
          request.bearerToken,
        );
        const reviewedAtMillis = yield* Clock.currentTimeMillis;
        if (tokenExpiresAtMillis <= reviewedAtMillis) {
          return yield* authenticationError("token_expired");
        }

        const resources = yield* Effect.all({
          pod: kubernetes.getPod({
            namespace: binding.namespace,
            name: binding.podName,
          }),
          serviceAccount: kubernetes.getServiceAccount({
            namespace: binding.namespace,
            name: binding.serviceAccountName,
          }),
        }, { concurrency: 2 });
        const live = yield* validateLiveKubernetesIdentity(binding, resources);

        const agents = yield* identityStore.findAgentsByWorkload({
          kubernetesNamespace: live.pod.namespace,
          kubernetesPod: live.pod.name,
        });
        const agent = yield* resolveActiveAgent(agents, live.pod);
        const assignmentId = request.assignmentRequirement === "required"
          ? yield* resolveActiveAssignment(identityStore, agent.agentId)
          : null;
        const validatedAtMillis = yield* Clock.currentTimeMillis;
        if (tokenExpiresAtMillis <= validatedAtMillis) {
          return yield* authenticationError("token_expired");
        }

        const identity = {
          schemaVersion: 1,
          agentId: agent.agentId,
          role: agent.role,
          fleet: agent.fleet,
          domain: agent.domain,
          assignmentId,
          kubernetesNamespace: live.pod.namespace,
          kubernetesPod: live.pod.name,
          podUid: live.pod.uid,
          serviceAccountName: live.serviceAccount.name,
          serviceAccountUid: live.serviceAccount.uid,
        } satisfies WorkloadIdentityV1;

        const cacheExpiresAtMillis = Math.min(
          tokenExpiresAtMillis,
          validatedAtMillis + AGENTOS_IDENTITY_POSITIVE_CACHE_TTL_MILLIS,
        );
        if (cacheExpiresAtMillis > validatedAtMillis) {
          yield* Ref.update(cache, (entries) => {
            const next = new Map(entries);
            next.set(cacheKey, {
              expiresAtMillis: cacheExpiresAtMillis,
              identity,
            });
            return next;
          });
        }
        yield* annotateIdentitySpan(identity, false);
        return identity;
      });

      const authenticate = (request: WorkloadIdentityAuthenticationRequest) =>
        authenticateEffect(request).pipe(
          Effect.withSpan("agentos.workload_identity.authenticate", {
            attributes: {
              "agentos.identity.token_audience":
                AGENTOS_EGRESS_TOKEN_AUDIENCE,
            },
          }),
        );

      return WorkloadIdentityAuthenticator.of({
        authenticate,
        invalidate: Effect.fn(
          "WorkloadIdentityAuthenticator.invalidate",
        )(function*(invalidation: WorkloadIdentityInvalidationV1) {
          yield* Ref.update(cache, (entries) => {
            if (invalidation.kind === "all") return new Map();
            const retained = new Map<string, PositiveCacheEntry>();
            for (const [key, entry] of entries) {
              if (!matchesInvalidation(entry.identity, invalidation)) {
                retained.set(key, entry);
              }
            }
            return retained;
          });
        }),
      });
    }),
  );
}

interface ReviewedBinding {
  readonly namespace: string;
  readonly serviceAccountName: string;
  readonly serviceAccountUid: string;
  readonly podName: string;
  readonly podUid: string;
}

interface LiveKubernetesIdentity {
  readonly pod: KubernetesPodIdentityV1;
  readonly serviceAccount: KubernetesServiceAccountIdentityV1;
}

function authenticationError(
  code: WorkloadAuthenticationError["code"],
) {
  return WorkloadAuthenticationError.make({ code });
}

function identityResolutionError(
  code: WorkloadIdentityResolutionError["code"],
) {
  return WorkloadIdentityResolutionError.make({ code });
}

const reviewedBinding = Effect.fn("workloadIdentity.reviewedBinding")(
  function*(reviewed: KubernetesReviewedIdentityV1) {
    if (!reviewed.authenticated) {
      return yield* authenticationError("token_review_rejected");
    }
    if (!reviewed.audiences.includes(AGENTOS_EGRESS_TOKEN_AUDIENCE)) {
      return yield* authenticationError("wrong_audience");
    }
    const parsed = parseServiceAccountUsername(reviewed.username);
    if (parsed === null) {
      return yield* authenticationError("invalid_service_account_username");
    }
    if (reviewed.serviceAccountUid === null) {
      return yield* authenticationError("service_account_uid_missing");
    }
    if (reviewed.podNames.length === 0 || reviewed.podUids.length === 0) {
      return yield* authenticationError("bound_pod_missing");
    }
    if (reviewed.podNames.length !== 1 || reviewed.podUids.length !== 1) {
      return yield* authenticationError("bound_pod_ambiguous");
    }
    return {
      ...parsed,
      serviceAccountUid: reviewed.serviceAccountUid,
      podName: reviewed.podNames[0]!,
      podUid: reviewed.podUids[0]!,
    } satisfies ReviewedBinding;
  },
);

function parseServiceAccountUsername(username: string | null): {
  readonly namespace: string;
  readonly serviceAccountName: string;
} | null {
  if (username === null) return null;
  const parts = username.split(":");
  if (
    parts.length !== 4 ||
    parts[0] !== "system" ||
    parts[1] !== "serviceaccount"
  ) {
    return null;
  }
  const namespace = parts[2]!;
  const serviceAccountName = parts[3]!;
  const namePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  if (
    namespace.length > 63 ||
    serviceAccountName.length > 63 ||
    !namePattern.test(namespace) ||
    !namePattern.test(serviceAccountName)
  ) {
    return null;
  }
  return { namespace, serviceAccountName };
}

const validateLiveKubernetesIdentity = Effect.fn(
  "workloadIdentity.validateLiveKubernetesIdentity",
)(function*(
  binding: ReviewedBinding,
  resources: {
    readonly pod: KubernetesPodIdentityV1 | null;
    readonly serviceAccount: KubernetesServiceAccountIdentityV1 | null;
  },
) {
  if (resources.pod === null) {
    return yield* authenticationError("pod_not_found");
  }
  if (resources.serviceAccount === null) {
    return yield* authenticationError("service_account_not_found");
  }
  const pod = resources.pod;
  const serviceAccount = resources.serviceAccount;
  if (pod.namespace !== binding.namespace || pod.name !== binding.podName) {
    return yield* authenticationError("pod_not_found");
  }
  if (pod.uid !== binding.podUid) {
    return yield* authenticationError("pod_uid_mismatch");
  }
  if (pod.deletionTimestampMillis !== null) {
    return yield* authenticationError("pod_deleting");
  }
  if (pod.phase !== "Running") {
    return yield* authenticationError("pod_not_running");
  }
  if (
    serviceAccount.namespace !== binding.namespace ||
    serviceAccount.name !== binding.serviceAccountName
  ) {
    return yield* authenticationError("service_account_not_found");
  }
  if (serviceAccount.uid !== binding.serviceAccountUid) {
    return yield* authenticationError("service_account_uid_mismatch");
  }
  if (serviceAccount.deletionTimestampMillis !== null) {
    return yield* authenticationError("service_account_deleting");
  }
  if (pod.serviceAccountName !== serviceAccount.name) {
    return yield* authenticationError("pod_service_account_mismatch");
  }
  return { pod, serviceAccount } satisfies LiveKubernetesIdentity;
});

const resolveActiveAgent = Effect.fn("workloadIdentity.resolveActiveAgent")(
  function*(
    agents: ReadonlyArray<AgentOSWorkloadAgentV1>,
    pod: KubernetesPodIdentityV1,
  ) {
    if (agents.length === 0) {
      return yield* identityResolutionError("agent_not_found");
    }
    if (agents.length !== 1) {
      return yield* identityResolutionError("agent_ambiguous");
    }
    const agent = agents[0]!;
    if (
      agent.kubernetesNamespace !== pod.namespace ||
      agent.kubernetesPod !== pod.name
    ) {
      return yield* identityResolutionError("agent_locator_mismatch");
    }
    if (agent.lifecycleStatus !== "active" || agent.retiredAtMillis !== null) {
      return yield* identityResolutionError("agent_inactive");
    }
    return agent;
  },
);

const resolveActiveAssignment = Effect.fn(
  "workloadIdentity.resolveActiveAssignment",
)(function*(
  identityStore: AgentOSWorkloadIdentityStore["Service"],
  agentId: string,
) {
  const assignments = yield* identityStore.findAssignmentsByAgent(agentId);
  if (assignments.length === 0) {
    return yield* identityResolutionError("assignment_not_found");
  }
  if (assignments.length !== 1) {
    return yield* identityResolutionError("assignment_ambiguous");
  }
  const assignment = assignments[0]!;
  if (assignment.agentId !== agentId) {
    return yield* WorkloadAuthorizationError.make({
      code: "assignment_owner_mismatch",
    });
  }
  if (assignment.status !== "active" || assignment.endedAtMillis !== null) {
    return yield* identityResolutionError("assignment_inactive");
  }
  return assignment.assignmentId;
});

function positiveCacheKey(request: WorkloadIdentityAuthenticationRequest) {
  const digest = createHash("sha256")
    .update(request.bearerToken, "utf8")
    .digest("hex");
  return `${digest}:${request.assignmentRequirement}`;
}

const takeLiveCacheEntry = Effect.fn("workloadIdentity.takeLiveCacheEntry")(
  function*(
    cache: Ref.Ref<ReadonlyMap<string, PositiveCacheEntry>>,
    key: string,
    now: number,
  ) {
    return yield* Ref.modify(cache, (
      entries,
    ): readonly [
      PositiveCacheEntry | undefined,
      ReadonlyMap<string, PositiveCacheEntry>,
    ] => {
      const entry = entries.get(key);
      if (entry !== undefined && entry.expiresAtMillis > now) {
        return [entry, entries];
      }
      if (entry === undefined) return [undefined, entries];
      const next = new Map(entries);
      next.delete(key);
      return [undefined, next];
    });
  },
);

function matchesInvalidation(
  identity: WorkloadIdentityV1,
  invalidation: Exclude<WorkloadIdentityInvalidationV1, { kind: "all" }>,
) {
  switch (invalidation.kind) {
    case "pod":
      return identity.podUid === invalidation.podUid;
    case "service_account":
      return identity.serviceAccountUid === invalidation.serviceAccountUid;
    case "agent":
      return identity.agentId === invalidation.agentId;
    case "assignment":
      return identity.assignmentId === invalidation.assignmentId;
  }
}

function tokenExpirationMillis(token: string) {
  const encodedPayload = tokenPayloadSegment(token);
  if (encodedPayload === null) {
    return Effect.fail(authenticationError("invalid_token"));
  }
  return Effect.fromResult(Encoding.decodeBase64UrlString(encodedPayload)).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(JwtExpirationPayload)),
    ),
    Effect.map(({ exp }) => exp * 1_000),
    Effect.mapError(() => authenticationError("invalid_token")),
  );
}

function tokenPayloadSegment(token: string): string | null {
  if (token.length === 0 || token.length > 16_384 || /\s/.test(token)) {
    return null;
  }
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts.some((part) => part.length === 0 || !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    return null;
  }
  return parts[1]!;
}

function annotateIdentitySpan(identity: WorkloadIdentityV1, cacheHit: boolean) {
  return Effect.annotateCurrentSpan({
    "agentos.agent.id": identity.agentId,
    "agentos.identity.cache_hit": cacheHit,
    "agentos.identity.assignment_required": identity.assignmentId !== null,
    "agentos.namespace": identity.kubernetesNamespace,
  });
}
