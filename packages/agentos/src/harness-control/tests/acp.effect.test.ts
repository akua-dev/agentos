import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  HarnessControlPlanError,
  compileHarnessControlPlan,
  decodeAcpControlEvent,
  decodeHarnessCorrelation,
} from "../acp.ts";

const AgentId = "10000000-0000-4000-8000-000000000001";
const AssignmentId = "20000000-0000-4000-8000-000000000001";
const PiSession = "/var/lib/agentos/pi/sessions/2026-08-01.jsonl";

function correlation() {
  return {
    version: 1,
    agentId: AgentId,
    assignmentId: AssignmentId,
    herdrSession: "agentos-platform-mate",
    herdrAgentName: "platform-mate",
    workspace: "/worktrees/assignment-1",
    nativeSession: {
      provider: "pi",
      referenceKind: "path",
      value: PiSession,
    },
    protocolSessionId: "pi-acp-session-1",
    sessionAuthority: "provider_native",
  };
}

function writer(
  writerId: string,
  mode: "native" | "acp",
  nativeSessionValue = PiSession,
) {
  return {
    version: 1,
    writerId,
    mode,
    custody: "herdr",
    nativeSessionValue,
  };
}

function transition(
  observedWriters: ReadonlyArray<ReturnType<typeof writer>>,
  request: {
    readonly reason: "operator_handoff" | "adapter_loss" | "replacement" | "wake";
    readonly targetMode: "native" | "acp";
  },
) {
  return {
    version: 1,
    correlation: correlation(),
    generation: 7,
    nativeSessionAvailable: true,
    recordedWriter: writer("writer-acp-7", "acp"),
    observedWriters,
    request: {
      expectedGeneration: 7,
      ...request,
    },
  };
}

function expectPlanFailure(input: unknown) {
  return compileHarnessControlPlan(input).pipe(
    Effect.flip,
    Effect.map((failure) => {
      assert.instanceOf(failure, HarnessControlPlanError);
      return failure;
    }),
  );
}

describe("ACP harness custody contract", () => {
  it.effect("correlates authorities without accepting transcript content", () =>
    Effect.gen(function*() {
      const decoded = yield* decodeHarnessCorrelation(correlation());
      assert.strictEqual(decoded.nativeSession.value, PiSession);
      assert.strictEqual(decoded.sessionAuthority, "provider_native");

      const failure = yield* decodeHarnessCorrelation({
        ...correlation(),
        transcript: "private conversation",
      }).pipe(Effect.flip);
      assert.strictEqual(failure.code, "invalid_contract");
    }));

  it.effect("fails closed when more than one writer is active", () =>
    Effect.gen(function*() {
      const failure = yield* expectPlanFailure(
        transition(
          [writer("writer-acp-7", "acp"), writer("writer-native-8", "native")],
          { reason: "operator_handoff", targetMode: "native" },
        ),
      );
      assert.strictEqual(failure.code, "multiple_active_writers");
    }));

  it.effect("orders a mode handoff as stop, verify exit, then exact-session start", () =>
    Effect.gen(function*() {
      const plan = yield* compileHarnessControlPlan(
        transition([writer("writer-acp-7", "acp")], {
          reason: "operator_handoff",
          targetMode: "native",
        }),
      );

      assert.deepStrictEqual(
        plan.actions.map(({ kind }) => kind),
        [
          "mark_not_ready",
          "stop_writer",
          "verify_writer_exit",
          "start_writer",
          "verify_single_writer",
          "persist_correlation",
          "mark_ready",
        ],
      );
      const start = plan.actions.find(({ kind }) => kind === "start_writer");
      assert.deepInclude(start, {
        kind: "start_writer",
        mode: "native",
        nativeSessionValue: PiSession,
      });
      assert.deepStrictEqual(plan.invariants, {
        sessionAuthority: "provider_native",
        maximumActiveWriters: 1,
        handoffOrdering: "stop_verify_start",
        promptQueue: "forbidden",
        transcriptStorage: "forbidden",
      });
    }));

  it.effect("recovers adapter loss through the exact native session only after zero writers are observed", () =>
    Effect.gen(function*() {
      const plan = yield* compileHarnessControlPlan(
        transition([], { reason: "adapter_loss", targetMode: "native" }),
      );
      assert.deepStrictEqual(
        plan.actions.map(({ kind }) => kind),
        [
          "mark_not_ready",
          "start_writer",
          "verify_single_writer",
          "persist_correlation",
          "mark_ready",
        ],
      );
      assert.strictEqual(plan.nextGeneration, 8);

      const stillRunning = yield* expectPlanFailure(
        transition([writer("writer-acp-7", "acp")], {
          reason: "adapter_loss",
          targetMode: "native",
        }),
      );
      assert.strictEqual(stillRunning.code, "adapter_still_active");
    }));

  it.effect("replaces and wakes a writer without opening a second custody path", () =>
    Effect.gen(function*() {
      const replacement = yield* compileHarnessControlPlan(
        transition([writer("writer-acp-7", "acp")], {
          reason: "replacement",
          targetMode: "acp",
        }),
      );
      assert.deepStrictEqual(
        replacement.actions.map(({ kind }) => kind),
        [
          "mark_not_ready",
          "stop_writer",
          "verify_writer_exit",
          "start_writer",
          "verify_single_writer",
          "persist_correlation",
          "mark_ready",
        ],
      );
      assert.strictEqual(replacement.nextGeneration, 8);

      const wake = yield* compileHarnessControlPlan(
        transition([writer("writer-acp-7", "acp")], {
          reason: "wake",
          targetMode: "acp",
        }),
      );
      assert.deepStrictEqual(
        wake.actions.map(({ kind }) => kind),
        ["wake_writer", "verify_single_writer"],
      );
      assert.strictEqual(wake.nextGeneration, 7);

      const modeChangingWake = yield* expectPlanFailure(
        transition([writer("writer-acp-7", "acp")], {
          reason: "wake",
          targetMode: "native",
        }),
      );
      assert.strictEqual(modeChangingWake.code, "invalid_transition");
    }));

  it.effect("rejects stale generations, missing native sessions, and mismatched observations", () =>
    Effect.gen(function*() {
      const stale = transition([writer("writer-acp-7", "acp")], {
        reason: "operator_handoff",
        targetMode: "native",
      });
      const staleFailure = yield* expectPlanFailure({
        ...stale,
        request: { ...stale.request, expectedGeneration: 6 },
      });
      assert.strictEqual(staleFailure.code, "stale_generation");

      const missingFailure = yield* expectPlanFailure({
        ...stale,
        nativeSessionAvailable: false,
      });
      assert.strictEqual(missingFailure.code, "native_session_missing");

      const mismatchFailure = yield* expectPlanFailure({
        ...stale,
        observedWriters: [writer("writer-acp-7", "acp", "/different/session")],
      });
      assert.strictEqual(mismatchFailure.code, "writer_mismatch");
    }));

  it.effect("types permission, cancellation, tool, plan, and error control metadata", () =>
    Effect.gen(function*() {
      const events = [
        {
          version: 1,
          kind: "permission",
          sessionId: "session-1",
          requestId: "permission-1",
          toolCallId: "tool-1",
          phase: "requested",
        },
        {
          version: 1,
          kind: "cancellation",
          sessionId: "session-1",
          source: "client",
          phase: "completed",
        },
        {
          version: 1,
          kind: "tool",
          sessionId: "session-1",
          toolCallId: "tool-1",
          status: "completed",
        },
        {
          version: 1,
          kind: "plan",
          sessionId: "session-1",
          revision: 2,
          entryCount: 3,
          status: "updated",
        },
        {
          version: 1,
          kind: "error",
          sessionId: "session-1",
          code: "provider_unavailable",
          retryability: "retryable",
        },
      ];

      const decoded = yield* Effect.forEach(events, decodeAcpControlEvent);
      assert.deepStrictEqual(
        decoded.map(({ kind }) => kind),
        ["permission", "cancellation", "tool", "plan", "error"],
      );

      const contentBearing = yield* decodeAcpControlEvent({
        ...events[2],
        command: "token-bearing command",
      }).pipe(Effect.flip);
      assert.strictEqual(contentBearing.code, "invalid_control_event");
    }));
});
