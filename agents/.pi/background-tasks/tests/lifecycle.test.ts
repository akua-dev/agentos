import { describe, expect, test } from "bun:test";

import {
  restoreTaskLifecycle,
  TASK_LIFECYCLE_ENTRY,
  taskLifecycleEntry,
} from "../lifecycle.ts";
import type { TaskSnapshot } from "../types.ts";

function runningTask(
  completionDelivery: "steer" | "followUp",
): TaskSnapshot {
  return {
    id: "bg-lifecycle",
    command: "native-wait",
    description: "Wait",
    state: "running",
    createdAt: "2026-07-27T10:00:00.000Z",
    startedAt: "2026-07-27T10:00:00.000Z",
    outputPath: "/tmp/bg-lifecycle.log",
    outputTail: "",
    outputTruncated: false,
    outputBytes: 0,
    completionDelivery,
    completionObserved: false,
    explicitlyKilled: false,
  };
}

describe("background task lifecycle delivery", () => {
  test("persists steering and defaults older entries to follow-up", () => {
    const persisted = {
      type: "custom",
      customType: TASK_LIFECYCLE_ENTRY,
      data: taskLifecycleEntry(runningTask("steer")),
    };
    expect(
      restoreTaskLifecycle([persisted]).tasks[0]?.completionDelivery,
    ).toBe("steer");

    const older = structuredClone(persisted) as {
      data: { task: { completionDelivery?: string } };
    };
    delete older.data.task.completionDelivery;
    expect(
      restoreTaskLifecycle([older]).tasks[0]?.completionDelivery,
    ).toBe("followUp");
  });
});
