import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

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

describe("Effect background-task lifecycle schema", () => {
  it.effect("persists delivery and defaults older valid entries to follow-up", () =>
    Effect.sync(() => {
      const data = taskLifecycleEntry(runningTask("steer"));
      const persisted = {
        type: "custom",
        customType: TASK_LIFECYCLE_ENTRY,
        data,
      };
      assert.strictEqual(
        restoreTaskLifecycle([persisted]).tasks[0]?.completionDelivery,
        "steer",
      );

      const { completionDelivery: _delivery, ...olderTask } = data.task;
      const older = {
        ...persisted,
        data: { ...data, task: olderTask },
      };
      assert.strictEqual(
        restoreTaskLifecycle([older]).tasks[0]?.completionDelivery,
        "followUp",
      );
    }));

  it.effect("rejects malformed entries and repairs running work to interrupted", () =>
    Effect.sync(() => {
      const valid = {
        type: "custom",
        customType: TASK_LIFECYCLE_ENTRY,
        data: taskLifecycleEntry(runningTask("followUp")),
      };
      const restored = restoreTaskLifecycle([
        { ...valid, data: { version: 1, task: { id: "../unsafe" } } },
        valid,
      ]);
      assert.lengthOf(restored.tasks, 1);
      assert.deepInclude(restored.tasks[0], {
        id: "bg-lifecycle",
        state: "interrupted",
        completionObserved: true,
      });
      assert.lengthOf(restored.interrupted, 1);
    }));

  it.effect("repairs shutdown cancellation but preserves an explicit kill", () =>
    Effect.sync(() => {
      const shutdown = runningTask("followUp");
      shutdown.state = "cancelled";
      const killed = runningTask("followUp");
      killed.id = "bg-killed";
      killed.state = "cancelled";
      killed.explicitlyKilled = true;
      const restored = restoreTaskLifecycle([
        {
          type: "custom",
          customType: TASK_LIFECYCLE_ENTRY,
          data: taskLifecycleEntry(shutdown),
        },
        {
          type: "custom",
          customType: TASK_LIFECYCLE_ENTRY,
          data: taskLifecycleEntry(killed),
        },
      ]);

      assert.deepInclude(restored.tasks[0], {
        id: "bg-lifecycle",
        state: "interrupted",
      });
      assert.deepInclude(restored.tasks[1], {
        explicitlyKilled: true,
        id: "bg-killed",
        state: "cancelled",
      });
    }));
});
