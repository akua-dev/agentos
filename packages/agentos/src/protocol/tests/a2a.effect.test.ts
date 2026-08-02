import { describe, it } from "@effect/vitest";
import assert from "node:assert/strict";
import { Effect } from "effect";

import {
  compileA2aAgentCard,
  compileA2aDeliveryRequest,
  compileA2aPublicAgentCard,
  evaluateA2aHierarchyRoute,
  evaluateA2aOutageRecovery,
  interpretA2aTransportResult,
  planA2aRetry,
  type A2aDeliveryInputV1,
} from "../a2a.ts";

const CallerAgentId = "11111111-1111-4111-8111-111111111111";
const TargetAgentId = "22222222-2222-4222-8222-222222222222";
const CommonAncestorAgentId = "33333333-3333-4333-8333-333333333333";
const InboxId = "44444444-4444-4444-8444-444444444444";
const TaskId = "55555555-5555-4555-8555-555555555555";
const AssignmentId = "66666666-6666-4666-8666-666666666666";

const delivery = (
  overrides: Partial<A2aDeliveryInputV1> = {},
): A2aDeliveryInputV1 => ({
  version: 1,
  authoritative: {
    inboxId: InboxId,
    taskId: TaskId,
    assignmentId: AssignmentId,
    status: "committed",
    committedAtMillis: 1_785_638_400_000,
  },
  callerAgentId: CallerAgentId,
  targetAgentId: TargetAgentId,
  edge: "direct_parent_child",
  speechAct: "request",
  skillId: "repository.implementation@v1",
  subject: "Implement the reviewed repository change",
  authorization: {
    identity: "authenticated",
    caller: "allowed",
    target: "allowed",
    skill: "allowed",
    hierarchyEdge: "allowed",
    assignment: "allowed",
  },
  ...overrides,
});

describe("PostgreSQL-first A2A v1 delivery contract", () => {
  it.effect("publishes identity and security without operational skill details", () =>
    Effect.gen(function*() {
      const card = yield* compileA2aPublicAgentCard({
        version: 1,
        targetAgentId: TargetAgentId,
        targetHandle: "platform-mate",
        description: "Owns the reviewed platform domain",
        agentVersion: "2026.08.01",
        baseUrl: "https://agents.example.test/fleet-alpha",
      });
      assert.strictEqual(card.name, "platform-mate");
      assert.deepStrictEqual(card.skills, []);
      assert.strictEqual(card.capabilities.extendedAgentCard, true);
      assert.deepStrictEqual(card.securityRequirements, [
        { schemes: { projectedServiceAccountBearer: [] } },
      ]);
    }));

  it.effect("compiles one content-free reference request only after the Inbox row commits", () =>
    Effect.gen(function*() {
      const compiled = yield* compileA2aDeliveryRequest(delivery());

      assert.deepStrictEqual(compiled.headers, {
        "A2A-Version": "1.0",
        "Content-Type": "application/json",
      });
      assert.strictEqual(compiled.body.jsonrpc, "2.0");
      assert.strictEqual(compiled.body.method, "SendMessage");
      assert.strictEqual(compiled.body.id, `agentos:inbox:${InboxId}`);
      assert.strictEqual(
        compiled.body.params.message.messageId,
        `agentos:inbox:${InboxId}`,
      );
      assert.strictEqual(
        compiled.body.params.message.contextId,
        `agentos:task:${TaskId}`,
      );
      assert.deepStrictEqual(compiled.body.params.message.parts, [
        {
          data: {
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
          },
          mediaType: "application/vnd.agentos.inbox-reference+json",
        },
      ]);
      assert.deepStrictEqual(compiled.body.params.configuration, {
        acceptedOutputModes: [
          "application/vnd.agentos.inbox-reference+json",
        ],
        historyLength: 0,
        returnImmediately: true,
      });
      assert.deepStrictEqual(compiled.correlation, {
        a2aContextId: `agentos:task:${TaskId}`,
        a2aDeliveryTaskId: `agentos:delivery:${InboxId}`,
        a2aMessageId: `agentos:inbox:${InboxId}`,
        assignmentId: AssignmentId,
        inboxId: InboxId,
        taskId: TaskId,
      });
      assert.deepStrictEqual(compiled.canonicalMutations, []);
      assert.strictEqual(compiled.idempotencyAuthority, "agentos.inbox.id");
    }));

  it.effect("makes retries byte-for-byte stable without a second authority", () =>
    Effect.gen(function*() {
      const first = yield* compileA2aDeliveryRequest(delivery());
      const retry = yield* compileA2aDeliveryRequest(delivery());

      assert.deepStrictEqual(retry, first);
      assert.strictEqual(retry.persistence, "none");
    }));

  it.effect("gives A2A retries no authority to duplicate durable or execution state", () =>
    Effect.gen(function*() {
      const unread = yield* planA2aRetry({
        version: 1,
        inboxId: InboxId,
        canonicalInbox: "unread",
      });
      assert.deepStrictEqual(unread, {
        version: 1,
        inboxId: InboxId,
        action: "wake_existing_reference",
        mayCreate: {
          task: false,
          assignment: false,
          inbox: false,
          execution: false,
          durableReport: false,
        },
      });

      for (const canonicalInbox of ["read", "resolved"]) {
        const received = yield* planA2aRetry({
          version: 1,
          inboxId: InboxId,
          canonicalInbox,
        });
        assert.strictEqual(received.action, "acknowledge_existing_delivery");
        assert.deepStrictEqual(received.mayCreate, unread.mayCreate);
      }
    }));

  it.effect("fails closed before transport for uncommitted, unauthorized, or lateral delivery", () =>
    Effect.gen(function*() {
      const uncommitted = yield* compileA2aDeliveryRequest(
        delivery({
          authoritative: {
            ...delivery().authoritative,
            status: "pending",
          },
        }),
      ).pipe(Effect.flip);
      assert.strictEqual(uncommitted.code, "canonical_row_not_committed");

      const unauthorized = yield* compileA2aDeliveryRequest(
        delivery({
          authorization: {
            ...delivery().authorization,
            skill: "denied",
          },
        }),
      ).pipe(Effect.flip);
      assert.strictEqual(unauthorized.code, "authorization_denied");

      const lateral = yield* compileA2aDeliveryRequest(
        delivery({ edge: "lateral" }),
      ).pipe(Effect.flip);
      assert.strictEqual(lateral.code, "hierarchy_edge_denied");
    }));

  it.effect("requires active Assignment authorization only when delivery is Assignment-scoped", () =>
    Effect.gen(function*() {
      const inactive = yield* compileA2aDeliveryRequest(
        delivery({
          authorization: {
            ...delivery().authorization,
            assignment: "denied",
          },
        }),
      ).pipe(Effect.flip);
      assert.strictEqual(inactive.code, "assignment_denied");

      const unscoped = yield* compileA2aDeliveryRequest(
        delivery({
          authoritative: {
            ...delivery().authoritative,
            assignmentId: null,
          },
          authorization: {
            ...delivery().authorization,
            assignment: "not_scoped",
          },
        }),
      );
      assert.strictEqual(unscoped.correlation.assignmentId, null);
    }));

  it.effect("rejects content-bearing or unbounded reference envelopes", () =>
    Effect.gen(function*() {
      const contentBearing = yield* compileA2aDeliveryRequest({
        ...delivery(),
        body: "This must stay in PostgreSQL",
      }).pipe(Effect.flip);
      assert.strictEqual(contentBearing.code, "invalid_contract");

      const unbounded = yield* compileA2aDeliveryRequest(
        delivery({ subject: "x".repeat(241) }),
      ).pipe(Effect.flip);
      assert.strictEqual(unbounded.code, "invalid_contract");
    }));

  it.effect("advertises only the reviewed, ceiling-bounded, caller-authorized skill intersection", () =>
    Effect.gen(function*() {
      const card = yield* compileA2aAgentCard({
        version: 1,
        targetAgentId: TargetAgentId,
        targetHandle: "platform-mate",
        description: "Owns the reviewed platform domain",
        agentVersion: "2026.08.01",
        baseUrl: "https://agents.example.test/fleet-alpha",
        skillVocabulary: [
          {
            id: "repository.implementation@v1",
            name: "Repository implementation",
            description: "Implements reviewed repository changes",
            tags: ["repository", "implementation"],
          },
          {
            id: "production.deployment@v1",
            name: "Production deployment",
            description: "Deploys approved production revisions",
            tags: ["production", "deployment"],
          },
          {
            id: "unreviewed.experimental@v1",
            name: "Experimental access",
            description: "Must never be advertised",
            tags: ["experimental"],
          },
        ],
        reviewedSkillIds: [
          "repository.implementation@v1",
          "production.deployment@v1",
        ],
        profileSkillIds: [
          "repository.implementation@v1",
          "production.deployment@v1",
        ],
        ceilingSkillIds: ["repository.implementation@v1"],
        authorizedSkillIds: [
          "repository.implementation@v1",
          "unreviewed.experimental@v1",
        ],
      });

      assert.deepStrictEqual(card.skills.map(({ id }) => id), [
        "repository.implementation@v1",
      ]);
      assert.deepStrictEqual(card.supportedInterfaces, [
        {
          url: `https://agents.example.test/fleet-alpha/agents/${TargetAgentId}/a2a/jsonrpc`,
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
      ]);
      assert.deepStrictEqual(card.capabilities, {
        streaming: false,
        pushNotifications: false,
        extendedAgentCard: true,
      });
      assert.deepStrictEqual(card.defaultInputModes, [
        "application/vnd.agentos.inbox-reference+json",
      ]);
      assert.deepStrictEqual(card.defaultOutputModes, [
        "application/vnd.agentos.inbox-reference+json",
      ]);
      assert.deepStrictEqual(card.securityRequirements, [
        { schemes: { projectedServiceAccountBearer: [] } },
      ]);
    }));

  it.effect("refuses an Agent Card with no effectively authorized reviewed skills", () =>
    Effect.gen(function*() {
      const failure = yield* compileA2aAgentCard({
        version: 1,
        targetAgentId: TargetAgentId,
        targetHandle: "platform-mate",
        description: "Owns the reviewed platform domain",
        agentVersion: "2026.08.01",
        baseUrl: "https://agents.example.test/fleet-alpha",
        skillVocabulary: [],
        reviewedSkillIds: [],
        profileSkillIds: [],
        ceilingSkillIds: [],
        authorizedSkillIds: [],
      }).pipe(Effect.flip);

      assert.strictEqual(failure.code, "no_authorized_skills");
    }));

  it.effect("routes only direct hierarchy edges and returns cross-domain work to the common ancestor", () =>
    Effect.gen(function*() {
      const direct = yield* evaluateA2aHierarchyRoute({
        version: 1,
        callerAgentId: CallerAgentId,
        targetAgentId: TargetAgentId,
        relationship: { kind: "direct_parent_child" },
      });
      assert.deepStrictEqual(direct, {
        version: 1,
        decision: "deliver_direct",
        nextHopAgentId: TargetAgentId,
      });

      const crossDomain = yield* evaluateA2aHierarchyRoute({
        version: 1,
        callerAgentId: CallerAgentId,
        targetAgentId: TargetAgentId,
        relationship: {
          kind: "cross_domain",
          commonAncestorAgentId: CommonAncestorAgentId,
        },
      });
      assert.deepStrictEqual(crossDomain, {
        version: 1,
        decision: "return_to_common_ancestor",
        nextHopAgentId: CommonAncestorAgentId,
      });

      const lateral = yield* evaluateA2aHierarchyRoute({
        version: 1,
        callerAgentId: CallerAgentId,
        targetAgentId: TargetAgentId,
        relationship: { kind: "lateral" },
      }).pipe(Effect.flip);
      assert.strictEqual(lateral.code, "hierarchy_edge_denied");
    }));

  it.effect("keeps A2A success, failure, timeout, and cancellation separate from canonical state", () =>
    Effect.gen(function*() {
      for (const transport of [
        "accepted",
        "failed",
        "timed_out",
        "cancelled",
      ]) {
        const outcome = yield* interpretA2aTransportResult({
          version: 1,
          inboxId: InboxId,
          transport,
          canonicalInbox: "unread",
          canonicalAssignment: "active",
        });
        assert.strictEqual(outcome.canonicalInbox, "unread");
        assert.strictEqual(outcome.canonicalAssignment, "active");
        assert.deepStrictEqual(outcome.canonicalMutations, []);
        assert.strictEqual(outcome.recovery, "postgres_listener_then_herdr_wake");
      }
    }));

  it.effect("keeps committed work discoverable through every required outage", () =>
    Effect.gen(function*() {
      for (const failure of [
        "caller",
        "gateway",
        "authorizer",
        "target_pod",
        "adapter",
        "stream",
        "postgresql",
      ]) {
        const recovery = yield* evaluateA2aOutageRecovery({
          version: 1,
          inboxId: InboxId,
          canonicalStatus: "committed",
          failure,
        });
        assert.deepStrictEqual(recovery, {
          version: 1,
          inboxId: InboxId,
          failure,
          committedWork: "unchanged",
          discovery: "postgresql_listener",
          wake: "herdr_after_recovery",
          a2aReplay: "same_inbox_reference_only",
        });
      }
    }));
});
