import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  decodeAssignmentExecutionEpochObservation,
} from "../retry-recovery.ts";

const AgentId = "11000000-0000-4000-8000-000000000001";
const AssignmentId = "22000000-0000-4000-8000-000000000001";
const OperationId = "33000000-0000-4000-8000-000000000001";

const exhaustedObservation = {
  version: 1,
  state: "exhausted",
  failureClass: "transport",
  retryCeiling: 5,
  attemptsObserved: 5,
  recoveryAction: null,
  agentId: AgentId,
  assignmentId: AssignmentId,
  operationId: OperationId,
  nativeSessionRef: "codex:thread-retry-1",
  replacementAssignmentId: null,
};

it.effect("decodes only a closed privacy-safe execution-epoch observation", () =>
  Effect.gen(function*() {
    expect(
      yield* decodeAssignmentExecutionEpochObservation(exhaustedObservation),
    ).toEqual(exhaustedObservation);

    for (const candidate of [
      { ...exhaustedObservation, report: "private final report" },
      { ...exhaustedObservation, prompt: "private prompt" },
      { ...exhaustedObservation, failureClass: "arbitrary provider body" },
      { ...exhaustedObservation, attemptsObserved: 33 },
      { ...exhaustedObservation, state: "active" },
      { ...exhaustedObservation, retryCeiling: 4 },
    ]) {
      expect(
        yield* Effect.result(
          decodeAssignmentExecutionEpochObservation(candidate),
        ),
      ).toMatchObject({ _tag: "Failure" });
    }
  }));
