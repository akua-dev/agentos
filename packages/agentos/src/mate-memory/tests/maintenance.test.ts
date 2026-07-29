import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMateMemoryStore,
  type MateMemoryStore,
} from "../../memory/store.ts";
import {
  createMemoryActivityStore,
  type MemoryActivityStore,
} from "../../memory/activity.ts";
import {
  createMaintenanceTools,
  isEligibleHumanInput,
  MateMemoryMaintenance,
  type MaintenanceAgentRunner,
  type MaintenanceRunRequest,
} from "../maintenance.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "agentos-maintenance-"));
  temporaryDirectories.push(home);
  const store = createMateMemoryStore(home);
  await store.ensureLayout();
  return { home, store };
}

describe("Mate memory automatic maintenance", () => {
  test("accepts only substantive direct human input", () => {
    expect(isEligibleHumanInput("remember this please", "interactive")).toBe(
      true,
    );
    expect(isEligibleHumanInput("correct that preference", "rpc")).toBe(true);
    expect(isEligibleHumanInput("two words", "interactive")).toBe(false);
    expect(isEligibleHumanInput("internal maintenance message", "extension")).toBe(
      false,
    );
    expect(isEligibleHumanInput("  \n ", "interactive")).toBe(false);
  });

  test("exposes only memory-scoped tools and validates every mutation", async () => {
    const { store } = await fixture();
    const tools = createMaintenanceTools(store, {
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    });
    expect(tools.map(({ name }) => name).sort()).toEqual([
      "memory_delete_topic",
      "memory_list_topics",
      "memory_read_index",
      "memory_read_topic",
      "memory_write_index",
      "memory_write_topic",
    ]);
    expect(
      tools.some(({ name }) =>
        ["bash", "read", "write", "edit", "grep", "find", "ls"].includes(name),
      ),
    ).toBe(false);

    const write = tools.find(({ name }) => name === "memory_write_topic")!;
    const written = await write.execute(
      "write-1",
      {
        path: "topics/reporting.md",
        type: "feedback",
        scope: "captain",
        source_principal: "captain",
        observed_at: "2026-07-28T08:00:00.000Z",
        pinned: false,
        body: "Lead with outcomes.",
      } as never,
      undefined,
      undefined,
      {} as never,
    );
    expect(written.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("topics/reporting.md"),
    });
    expect((await store.readTopic("topics/reporting.md")).metadata.modified).toBe(
      "2026-07-28T12:00:00.000Z",
    );
    await expect(
      write.execute(
        "write-2",
        {
          path: "../escape.md",
          type: "feedback",
          scope: "captain",
          source_principal: "captain",
          observed_at: "2026-07-28T08:00:00.000Z",
          pinned: false,
          body: "Escape.",
        } as never,
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("topics/");
  });

  test("reports an oversized index after the durable write commits", async () => {
    const { home, store } = await fixture();
    const write = createMaintenanceTools(store).find(
      ({ name }) => name === "memory_write_index",
    )!;
    const content = `${Array.from({ length: 201 }, (_, index) => `line ${index}`).join("\n")}\n`;

    await expect(
      write.execute(
        "write-index",
        { content } as never,
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("MEMORY.md exceeds the 200-line loading limit");
    expect(await readFile(join(home, "memory", "MEMORY.md"), "utf8")).toBe(
      content,
    );
  });

  test("coalesces bursts to the newest bounded extraction window", async () => {
    const { store } = await fixture();
    const requests: MaintenanceRunRequest[] = [];
    let releaseFirst!: () => void;
    const firstRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runner: MaintenanceAgentRunner = async (request) => {
      requests.push(request);
      if (requests.length === 1) await firstRunning;
      return { summary: "nothing to save", touchedPaths: [] };
    };
    const maintenance = new MateMemoryMaintenance({
      store,
      runner,
      isPaused: () => false,
      maxInputCharacters: 80,
    });

    maintenance.captureHumanInput(
      "First substantive human request",
      "interactive",
    );
    maintenance.afterAgentSettled(baseContext());
    await Promise.resolve();
    maintenance.captureHumanInput(
      "Second substantive human request",
      "interactive",
    );
    maintenance.captureHumanInput(
      "Newest substantive human request",
      "interactive",
    );
    maintenance.afterAgentSettled(baseContext());
    releaseFirst();
    await maintenance.drain(1_000);

    expect(requests).toHaveLength(2);
    expect(requests[0]!.prompt).toContain("First substantive");
    expect(requests[1]!.prompt).toContain("Newest substantive");
    expect(requests[1]!.prompt).not.toContain("Second substantive");
    expect(requests[1]!.tools.map(({ name }) => name)).not.toContain("bash");
  });

  test("redacts credentials before sending direct input to extraction", async () => {
    const { store } = await fixture();
    const requests: MaintenanceRunRequest[] = [];
    const maintenance = new MateMemoryMaintenance({
      store,
      runner: async (request) => {
        requests.push(request);
        return { summary: "nothing to save", touchedPaths: [] };
      },
      isPaused: () => false,
    });

    maintenance.captureHumanInput(
      "Remember this preference, password: hunter2, sk-proj-secret-value, AKIA1234567890ABCDEF, and xoxb-secret-value.",
      "interactive",
    );
    maintenance.afterAgentSettled(baseContext());
    await maintenance.drain(1_000);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toContain("Remember this preference");
    expect(requests[0]!.prompt).not.toContain("hunter2");
    expect(requests[0]!.prompt).not.toContain("sk-proj-secret-value");
    expect(requests[0]!.prompt).not.toContain("AKIA1234567890ABCDEF");
    expect(requests[0]!.prompt).not.toContain("xoxb-secret-value");
  });

  test("suppresses extraction after a direct memory edit and while paused", async () => {
    const { store } = await fixture();
    const requests: MaintenanceRunRequest[] = [];
    let paused = false;
    const maintenance = new MateMemoryMaintenance({
      store,
      runner: async (request) => {
        requests.push(request);
        return { summary: "nothing to save", touchedPaths: [] };
      },
      isPaused: () => paused,
    });

    maintenance.captureHumanInput("Remember this direct change", "interactive");
    maintenance.noteDirectMemoryWrite();
    maintenance.afterAgentSettled(baseContext());
    await maintenance.drain(1_000);
    expect(requests).toEqual([]);

    paused = true;
    maintenance.captureHumanInput("Remember this while paused", "rpc");
    maintenance.afterAgentSettled(baseContext());
    await maintenance.drain(1_000);
    expect(requests).toEqual([]);
  });

  test("blocks an in-flight extraction from mutating memory after pause", async () => {
    const { store } = await fixture();
    let paused = false;
    let releaseRunner!: () => void;
    let markStarted!: () => void;
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    let mutationOutcome = "not attempted";
    const runnerReleased = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const runnerStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const delayedStore: MateMemoryStore = {
      ...store,
      async writeTopic(topic, options) {
        markWriteStarted();
        await writeReleased;
        return store.writeTopic(topic, options);
      },
    };
    const maintenance = new MateMemoryMaintenance({
      store: delayedStore,
      isPaused: () => paused,
      runner: async (request) => {
        markStarted();
        await runnerReleased;
        const write = request.tools.find(
          ({ name }) => name === "memory_write_topic",
        )!;
        try {
          await write.execute(
            "late-write",
            {
              path: "topics/late.md",
              type: "feedback",
              scope: "captain",
              source_principal: "captain",
              observed_at: "2026-07-28T08:00:00.000Z",
              pinned: false,
              body: "This write must be blocked after pause.",
            } as never,
            undefined,
            undefined,
            {} as never,
          );
          mutationOutcome = "wrote";
        } catch (error) {
          mutationOutcome =
            error instanceof Error ? error.message : String(error);
        }
        return { summary: "finished after pause", touchedPaths: [] };
      },
    });

    maintenance.captureHumanInput(
      "Remember this only if memory stays active",
      "interactive",
    );
    maintenance.afterAgentSettled(baseContext());
    await runnerStarted;
    releaseRunner();
    await writeStarted;
    paused = true;
    releaseWrite();
    await maintenance.drain(1_000);

    expect(mutationOutcome).toContain("paused");
    await expect(store.readTopic("topics/late.md")).rejects.toThrow();
  });

  test("blocks an in-flight extraction after pause and resume", async () => {
    const { store } = await fixture();
    let paused = false;
    let generation = 1;
    let releaseRunner!: () => void;
    let markStarted!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runnerReleased = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let mutationOutcome = "not attempted";
    const maintenance = new MateMemoryMaintenance({
      store,
      isPaused: () => paused,
      getPauseGeneration: () => generation,
      runner: async (request) => {
        markStarted();
        await runnerReleased;
        const write = request.tools.find(({ name }) => name === "memory_write_topic")!;
        try {
          await write.execute(
            "late-write",
            {
              path: "topics/late.md",
              type: "feedback",
              scope: "captain",
              source_principal: "captain",
              observed_at: "2026-07-28T08:00:00.000Z",
              pinned: false,
              body: "This write must be blocked after resume.",
            } as never,
            undefined,
            undefined,
            {} as never,
          );
          mutationOutcome = "wrote";
        } catch (error) {
          mutationOutcome = error instanceof Error ? error.message : String(error);
        }
        return { summary: "finished after resume", touchedPaths: [] };
      },
    });

    maintenance.captureHumanInput("Remember this only in the original generation", "interactive");
    maintenance.afterAgentSettled(baseContext());
    await runnerStarted;
    paused = true;
    generation += 1;
    paused = false;
    generation += 1;
    releaseRunner();
    await maintenance.drain(1_000);

    expect(mutationOutcome).toContain("generation");
    await expect(store.readTopic("topics/late.md")).rejects.toThrow();
  });

  test("invalidates an active extraction when direct memory writing begins", async () => {
    const { store } = await fixture();
    let releaseRunner!: () => void;
    let markStarted!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runnerReleased = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let mutationOutcome = "not attempted";
    const maintenance = new MateMemoryMaintenance({
      store,
      isPaused: () => false,
      runner: async (request) => {
        markStarted();
        await runnerReleased;
        const write = request.tools.find(({ name }) => name === "memory_write_topic")!;
        try {
          await write.execute(
            "late-write",
            {
              path: "topics/late.md",
              type: "feedback",
              scope: "captain",
              source_principal: "captain",
              observed_at: "2026-07-28T08:00:00.000Z",
              pinned: false,
              body: "This write must be invalidated.",
            } as never,
            undefined,
            undefined,
            {} as never,
          );
          mutationOutcome = "wrote";
        } catch (error) {
          mutationOutcome = error instanceof Error ? error.message : String(error);
        }
        return { summary: "finished after direct write", touchedPaths: [] };
      },
    });

    maintenance.captureHumanInput("Remember this while extraction is active", "interactive");
    maintenance.afterAgentSettled(baseContext());
    await runnerStarted;
    maintenance.beginDirectMemoryWrite();
    releaseRunner();
    await maintenance.drain(1_000);

    expect(mutationOutcome).toContain("changed");
    await expect(store.readTopic("topics/late.md")).rejects.toThrow();
  });

  test("honors the released extraction stride", async () => {
    const { home } = await fixture();
    const store = createMateMemoryStore(home, { extractionStride: 2 });
    const requests: MaintenanceRunRequest[] = [];
    const maintenance = new MateMemoryMaintenance({
      store,
      runner: async (request) => {
        requests.push(request);
        return { summary: "nothing to save", touchedPaths: [] };
      },
      isPaused: () => false,
    });

    maintenance.captureHumanInput("First eligible human input", "interactive");
    maintenance.afterAgentSettled(baseContext());
    await maintenance.drain(1_000);
    expect(requests).toEqual([]);

    maintenance.captureHumanInput("Second eligible human input", "interactive");
    maintenance.afterAgentSettled(baseContext());
    await maintenance.drain(1_000);
    expect(requests).toHaveLength(1);
  });

  test("reports failures without failing the main run and drains shutdown work", async () => {
    const { store } = await fixture();
    const events: Array<{ status: string; summary: string }> = [];
    const maintenance = new MateMemoryMaintenance({
      store,
      runner: async () => {
        throw new Error("provider unavailable");
      },
      isPaused: () => false,
      onEvent: (event) => events.push(event),
    });
    maintenance.captureHumanInput(
      "Persist this useful preference",
      "interactive",
    );
    maintenance.afterAgentSettled(baseContext());

    await expect(maintenance.drain(1_000)).resolves.toBeUndefined();
    expect(events).toEqual([
      {
        status: "failed",
        summary: "automatic extraction failed",
      },
    ]);
  });

  test("does not persist model output, error details, or paths in maintenance events", async () => {
    const { store } = await fixture();
    const events: Array<{ status: string; summary: string }> = [];
    const maintenance = new MateMemoryMaintenance({
      store,
      runner: async () => ({
        summary: "secret memory body from the model",
        touchedPaths: ["topics/api-key-secret.md"],
      }),
      isPaused: () => false,
      onEvent: (event) => events.push(event),
    });

    maintenance.captureHumanInput("Persist this useful preference", "interactive");
    maintenance.afterAgentSettled(baseContext());
    await maintenance.drain(1_000);

    expect(events).toEqual([
      {
        status: "succeeded",
        summary: "automatic extraction completed",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");

    const failed = new MateMemoryMaintenance({
      store,
      runner: async () => {
        throw new Error("secret provider response");
      },
      isPaused: () => false,
      onEvent: (event) => events.push(event),
    });
    failed.captureHumanInput("Persist another useful preference", "interactive");
    failed.afterAgentSettled(baseContext());
    await failed.drain(1_000);

    expect(events.at(-1)).toEqual({
      status: "failed",
      summary: "automatic extraction failed",
    });
    expect(JSON.stringify(events)).not.toContain("provider response");
  });

  test("runs Dream only after both thresholds and marks success after completion", async () => {
    const { home, store } = await fixture();
    const activity = createMemoryActivityStore(home);
    await activity.ensureState(new Date("2026-07-26T08:00:00.000Z"));
    for (let index = 0; index < 5; index += 1) {
      await activity.completeSession(
        `prior-${index}`,
        new Date(`2026-07-27T0${index}:00:00.000Z`),
      );
    }
    const requests: MaintenanceRunRequest[] = [];
    const maintenance = new MateMemoryMaintenance({
      store,
      runner: async (request) => {
        requests.push(request);
        return {
          summary: "merged duplicate reporting topics",
          touchedPaths: ["topics/reporting.md"],
        };
      },
      isPaused: () => false,
      now: () => new Date("2026-07-28T08:00:00.000Z"),
    });

    await maintenance.maybeDream(baseContext(), activity, "current");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.kind).toBe("dream");
    expect(requests[0]!.tools.map(({ name }) => name)).toContain(
      "memory_read_activity",
    );
    expect((await activity.readState()).lastSuccessfulDreamAt).toBe(
      "2026-07-28T08:00:00.000Z",
    );
  });

  test("does not persist a Dream discovery marker after its guard changes", async () => {
    const { home, store } = await fixture();
    const realActivity = createMemoryActivityStore(home);
    await realActivity.ensureState(new Date("2026-07-26T08:00:00.000Z"));
    for (let index = 0; index < 5; index += 1) {
      await realActivity.completeSession(
        `prior-${index}`,
        new Date(`2026-07-27T0${index}:00:00.000Z`),
      );
    }
    let paused = false;
    const activity: MemoryActivityStore = {
      ...realActivity,
      async markDreamDiscovery(at, options) {
        paused = true;
        return realActivity.markDreamDiscovery(at, options);
      },
    };
    const maintenance = new MateMemoryMaintenance({
      store,
      runner: async () => ({ summary: "not reached", touchedPaths: [] }),
      isPaused: () => paused,
      now: () => new Date("2026-07-28T08:00:00.000Z"),
    });

    await maintenance.maybeDream(baseContext(), activity, "current");

    expect((await realActivity.readState()).lastDreamDiscoveryAt).toBeUndefined();
  });

  test("does not persist a Dream success marker after its guard changes", async () => {
    const { home, store } = await fixture();
    const realActivity = createMemoryActivityStore(home);
    await realActivity.ensureState(new Date("2026-07-26T08:00:00.000Z"));
    for (let index = 0; index < 5; index += 1) {
      await realActivity.completeSession(
        `prior-${index}`,
        new Date(`2026-07-27T0${index}:00:00.000Z`),
      );
    }
    let paused = false;
    const activity: MemoryActivityStore = {
      ...realActivity,
      async markDreamSuccess(at, options) {
        paused = true;
        return realActivity.markDreamSuccess(at, options);
      },
    };
    const maintenance = new MateMemoryMaintenance({
      store,
      runner: async () => ({ summary: "dreamed", touchedPaths: [] }),
      isPaused: () => paused,
      now: () => new Date("2026-07-28T08:00:00.000Z"),
    });

    await maintenance.maybeDream(baseContext(), activity, "current");

    expect((await realActivity.readState()).lastSuccessfulDreamAt).toBeUndefined();
  });

  test("releases the Dream lock and preserves the prior schedule marker on failure", async () => {
    const { home, store } = await fixture();
    const activity = createMemoryActivityStore(home);
    await activity.ensureState(new Date("2026-07-26T08:00:00.000Z"));
    for (let index = 0; index < 5; index += 1) {
      await activity.completeSession(
        `prior-${index}`,
        new Date(`2026-07-27T0${index}:00:00.000Z`),
      );
    }
    const maintenance = new MateMemoryMaintenance({
      store,
      runner: async () => {
        throw new Error("Dream failed");
      },
      isPaused: () => false,
      now: () => new Date("2026-07-28T08:00:00.000Z"),
    });

    await maintenance.maybeDream(baseContext(), activity, "current");

    expect((await activity.readState()).lastSuccessfulDreamAt).toBeUndefined();
    await expect(
      readFile(join(home, "memory", ".consolidate-lock"), "utf8"),
    ).rejects.toThrow();
  });
});

function baseContext() {
  return {
    agentDir: "/mate/.pi/agent",
    cwd: "/workspace",
    model: { provider: "test", id: "model" },
    signal: undefined,
  } as never;
}
