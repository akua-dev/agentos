import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import type {
  Api,
  AssistantMessage,
  Model,
  StopReason,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import {
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
} from "effect";

import {
  createMemoryActivityStore,
  type MemoryActivityStore,
} from "../../memory/activity.ts";
import {
  createMateMemoryStore,
  type MateMemoryStore,
} from "../../memory/store.ts";
import { createTelemetryRecorder } from "../../telemetry/tests/fake-telemetry.ts";
import {
  createMaintenanceTools,
  isEligibleHumanInput,
  MateMemoryMaintenance,
  MateMemoryMaintenanceError,
  runIsolatedMaintenanceAgent,
  type MaintenanceAgentRunner,
  type MaintenanceRunContext,
  type MaintenanceRunRequest,
  type MaintenanceTool,
} from "../maintenance.ts";

const platformLayer = Layer.mergeAll(
  BunCrypto.layer,
  BunFileSystem.layer,
  BunPath.layer,
);
const Json = Schema.fromJsonString(Schema.Unknown);
const fixedNow = Effect.succeed(new Date("2026-07-28T08:00:00.000Z"));

function selectorModel(): Model<Api> {
  return {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "http://ai-gateway:8787",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100_000,
  };
}

function completion(
  text: string,
  stopReason: StopReason = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: {
      input: 8,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 11,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: 1,
  };
}

function fixture(overrides: Parameters<typeof createMateMemoryStore>[1] = {}) {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "agentos-maintenance-",
    });
    const store = yield* createMateMemoryStore(home, overrides);
    yield* store.ensureLayout();
    return { fileSystem, home, paths, store };
  });
}

function run<A, E>(
  effect: Effect.Effect<
    A,
    E,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope
  >,
) {
  return Effect.scoped(effect).pipe(Effect.provide(platformLayer));
}

function baseContext(): MaintenanceRunContext {
  return {
    agentDir: "/mate/.pi/agent",
    cwd: "/workspace",
    model: selectorModel(),
    resolveAuth: Effect.succeed({ ok: true }),
  };
}

function toolNamed(
  tools: ReadonlyArray<MaintenanceTool>,
  name: string,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  return tool === undefined
    ? Effect.die(`Missing maintenance tool ${name}.`)
    : Effect.succeed(tool);
}

function runnerFailure(message: string) {
  return MateMemoryMaintenanceError.make({
    cause: message,
    code: "request_failed",
    message,
  });
}

function eligibleActivity(home: string) {
  return Effect.gen(function*() {
    const activity = yield* createMemoryActivityStore(home);
    yield* activity.ensureState(new Date("2026-07-26T08:00:00.000Z"));
    yield* Effect.forEach(
      Array.from({ length: 5 }, (_, index) => index),
      (index) =>
        activity.completeSession(
          `prior-${index}`,
          new Date(`2026-07-27T0${index}:00:00.000Z`),
        ),
      { discard: true },
    );
    return activity;
  });
}

describe("Mate memory Effect maintenance", () => {
  it.effect("attributes isolated model steps without recording maintenance content", () =>
    Effect.gen(function*() {
      const recorded = createTelemetryRecorder();
      const forwarded = yield* Ref.make(
        Option.none<Record<string, string | null>>(),
      );
      const authHeaders = { "x-original": "preserved" };
      const result = yield* runIsolatedMaintenanceAgent({
        ...baseContext(),
        kind: "extraction",
        pauseGeneration: 0,
        mutationEpoch: 0,
        resolveAuth: Effect.succeed({
          ok: true,
          apiKey: "sk-seeded-secret",
          headers: authHeaders,
        }),
        systemPrompt: "SEED_PROMPT private maintenance system prompt",
        prompt: "SEED_PROMPT private memory body",
        tools: [],
        telemetry: recorded.telemetry,
        completeImpl: (_model, _context, options) =>
          Ref.set(
            forwarded,
            Option.some(options?.headers ?? {}),
          ).pipe(Effect.as(completion('{"action":"done"}'))),
      });

      expect(result).toEqual({
        summary: "maintenance completed",
        touchedPaths: [],
      });
      expect(recorded.operations[0]?.attempts).toEqual([
        {
          input: {
            requestKind: "memory_extract",
            streamMode: "non_streaming",
          },
          outcome: {
            inputTokens: 8,
            outputTokens: 3,
            status: 200,
            streamOutcome: "completed",
          },
        },
      ]);
      const encoded = yield* Schema.encodeEffect(Json)(recorded.operations);
      expect(encoded).not.toContain("SEED_PROMPT");
      expect(encoded).not.toContain("sk-seeded-secret");
      expect(Option.getOrUndefined(yield* Ref.get(forwarded))).toMatchObject({
        "x-original": "preserved",
        traceparent: expect.any(String),
        "x-agentos-request-attempt-id": expect.any(String),
      });
      expect(authHeaders).toEqual({ "x-original": "preserved" });
    }),
  );

  it.effect("distinguishes consolidation model steps from extraction", () =>
    Effect.gen(function*() {
      const recorded = createTelemetryRecorder();
      const result = yield* runIsolatedMaintenanceAgent({
        ...baseContext(),
        kind: "dream",
        pauseGeneration: 0,
        mutationEpoch: 0,
        systemPrompt: "SEED_PROMPT private consolidation system prompt",
        prompt: "SEED_PROMPT private consolidation body",
        tools: [],
        telemetry: recorded.telemetry,
        completeImpl: () => Effect.succeed(completion('{"action":"done"}')),
      });

      expect(result).toEqual({
        summary: "maintenance completed",
        touchedPaths: [],
      });
      expect(recorded.operations[0]?.attempts).toEqual([
        {
          input: {
            requestKind: "memory_consolidate",
            streamMode: "non_streaming",
          },
          outcome: {
            inputTokens: 8,
            outputTokens: 3,
            status: 200,
            streamOutcome: "completed",
          },
        },
      ]);
      const encoded = yield* Schema.encodeEffect(Json)(recorded.operations);
      expect(encoded).not.toContain("SEED_PROMPT");
    }),
  );

  it.effect("accepts only direct substantive input and exposes memory-scoped validated tools", () =>
    run(Effect.gen(function*() {
      expect(isEligibleHumanInput("remember this please", "interactive")).toBe(
        true,
      );
      expect(isEligibleHumanInput("correct that preference", "rpc")).toBe(true);
      expect(isEligibleHumanInput("two words", "interactive")).toBe(false);
      expect(isEligibleHumanInput("internal maintenance message", "extension"))
        .toBe(false);
      expect(isEligibleHumanInput("  \n ", "interactive")).toBe(false);

      const { fileSystem, home, paths, store } = yield* fixture();
      const tools = createMaintenanceTools(store, {
        now: Effect.succeed(new Date("2026-07-28T12:00:00.000Z")),
      });
      expect(tools.map(({ name }) => name).sort()).toEqual([
        "memory_delete_topic",
        "memory_list_topics",
        "memory_read_index",
        "memory_read_topic",
        "memory_write_index",
        "memory_write_topic",
      ]);
      expect(tools.some(({ name }) =>
        ["bash", "read", "write", "edit", "grep", "find", "ls"].includes(name)
      )).toBe(false);

      const writeTopic = yield* toolNamed(tools, "memory_write_topic");
      const written = yield* writeTopic.execute({
        path: "topics/reporting.md",
        type: "feedback",
        scope: "captain",
        source_principal: "captain",
        observed_at: "2026-07-28T08:00:00.000Z",
        pinned: false,
        body: "Lead with outcomes.",
      });
      expect(written.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("topics/reporting.md"),
      });
      expect((yield* store.readTopic("topics/reporting.md")).metadata.modified)
        .toBe("2026-07-28T12:00:00.000Z");
      const escaped = yield* writeTopic.execute({
        path: "../escape.md",
        type: "feedback",
        scope: "captain",
        source_principal: "captain",
        observed_at: "2026-07-28T08:00:00.000Z",
        pinned: false,
        body: "Escape.",
      }).pipe(Effect.flip);
      expect(escaped.message).toContain("topics/");

      const writeIndex = yield* toolNamed(tools, "memory_write_index");
      const content = `${Array.from(
        { length: 201 },
        (_, index) => `line ${index}`,
      ).join("\n")}\n`;
      const oversized = yield* writeIndex.execute({ content }).pipe(Effect.flip);
      expect(oversized.message).toContain("200-line loading limit");
      expect(yield* fileSystem.readFileString(
        paths.join(home, "memory", "MEMORY.md"),
      )).toBe(content);
    })),
  );

  it.effect("coalesces bursts to the newest bounded and redacted extraction window", () =>
    run(Effect.gen(function*() {
      const { store } = yield* fixture();
      const requests = yield* Ref.make<ReadonlyArray<MaintenanceRunRequest>>([]);
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const runner: MaintenanceAgentRunner = (request) =>
        Ref.updateAndGet(requests, (current) => [...current, request]).pipe(
          Effect.flatMap((current) =>
            current.length === 1
              ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirst)),
              )
              : Effect.void
          ),
          Effect.as({ summary: "nothing to save", touchedPaths: [] }),
        );
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
      yield* maintenance.afterAgentSettled(baseContext());
      yield* Deferred.await(firstStarted);
      maintenance.captureHumanInput(
        "Second substantive human request",
        "interactive",
      );
      maintenance.captureHumanInput(
        "Newest substantive human request password: hunter2",
        "interactive",
      );
      yield* maintenance.afterAgentSettled(baseContext());
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* maintenance.drain(1_000);

      const captured = yield* Ref.get(requests);
      expect(captured).toHaveLength(2);
      expect(captured[0]?.prompt).toContain("First substantive");
      expect(captured[1]?.prompt).toContain("Newest substantive");
      expect(captured[1]?.prompt).not.toContain("Second substantive");
      expect(captured[1]?.prompt).not.toContain("hunter2");
      expect(captured[1]?.tools.map(({ name }) => name)).not.toContain("bash");
    })),
  );

  it.effect("honors stride and suppression while keeping event payloads content-free", () =>
    run(Effect.gen(function*() {
      const strideFixture = yield* fixture({ extractionStride: 2 });
      const requests = yield* Ref.make<ReadonlyArray<MaintenanceRunRequest>>([]);
      const events: Array<{ status: string; summary: string }> = [];
      const maintenance = new MateMemoryMaintenance({
        store: strideFixture.store,
        runner: (request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(
            Effect.as({
              summary: "secret memory body from the model",
              touchedPaths: ["topics/api-key-secret.md"],
            }),
          ),
        isPaused: () => false,
        onEvent: (event) => events.push(event),
      });
      maintenance.captureHumanInput("First eligible human input", "interactive");
      yield* maintenance.afterAgentSettled(baseContext());
      yield* maintenance.drain(1_000);
      expect(yield* Ref.get(requests)).toEqual([]);
      maintenance.captureHumanInput("Second eligible human input", "interactive");
      yield* maintenance.afterAgentSettled(baseContext());
      yield* maintenance.drain(1_000);
      expect(yield* Ref.get(requests)).toHaveLength(1);
      const encoded = yield* Schema.encodeEffect(Json)(events);
      expect(encoded).toContain("automatic extraction completed");
      expect(encoded).not.toContain("secret");

      maintenance.captureHumanInput("Remember this direct change", "interactive");
      maintenance.noteDirectMemoryWrite();
      yield* maintenance.afterAgentSettled(baseContext());
      yield* maintenance.drain(1_000);
      expect(yield* Ref.get(requests)).toHaveLength(1);

      const failureFixture = yield* fixture();
      const failureEvents: Array<{ status: string; summary: string }> = [];
      const failed = new MateMemoryMaintenance({
        store: failureFixture.store,
        runner: () => Effect.fail(runnerFailure("secret provider response")),
        isPaused: () => false,
        onEvent: (event) => failureEvents.push(event),
      });
      failed.captureHumanInput("Persist another useful preference", "interactive");
      yield* failed.afterAgentSettled(baseContext());
      yield* failed.drain(1_000);
      expect(failureEvents).toEqual([{
        status: "failed",
        summary: "automatic extraction failed",
      }]);
      expect(yield* Schema.encodeEffect(Json)(failureEvents)).not.toContain(
        "provider response",
      );
    })),
  );

  it.effect("blocks in-flight mutations after pause, resume, or a direct-write epoch change", () =>
    run(Effect.gen(function*() {
      const pausedFixture = yield* fixture();
      const writeStarted = yield* Deferred.make<void>();
      const releaseWrite = yield* Deferred.make<void>();
      let paused = false;
      const delayedStore: MateMemoryStore = {
        ...pausedFixture.store,
        writeTopic: (topic, options = {}) =>
          pausedFixture.store.writeTopic(topic, {
            ...options,
            beforeCommit: Deferred.succeed(writeStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseWrite)),
              Effect.andThen(options.beforeCommit ?? Effect.void),
            ),
          }),
      };
      const mutationOutcome = yield* Ref.make("not attempted");
      const runner: MaintenanceAgentRunner = (request) =>
        Effect.gen(function*() {
          const write = yield* toolNamed(request.tools, "memory_write_topic");
          const result = yield* write.execute({
            path: "topics/late.md",
            type: "feedback",
            scope: "captain",
            source_principal: "captain",
            observed_at: "2026-07-28T08:00:00.000Z",
            pinned: false,
            body: "This write must be blocked after pause.",
          }).pipe(Effect.result);
          yield* Ref.set(
            mutationOutcome,
            result._tag === "Failure" ? result.failure.message : "wrote",
          );
          return { summary: "finished", touchedPaths: [] };
        });
      const maintenance = new MateMemoryMaintenance({
        store: delayedStore,
        runner,
        isPaused: () => paused,
      });
      maintenance.captureHumanInput(
        "Remember this only if memory stays active",
        "interactive",
      );
      yield* maintenance.afterAgentSettled(baseContext());
      yield* Deferred.await(writeStarted);
      paused = true;
      yield* Deferred.succeed(releaseWrite, undefined);
      yield* maintenance.drain(1_000);
      expect(yield* Ref.get(mutationOutcome)).toContain("paused");
      expect((yield* pausedFixture.store.readTopic("topics/late.md").pipe(
        Effect.flip,
      )).code).toBe("io_failed");

      const resumedFixture = yield* fixture();
      const runnerStarted = yield* Deferred.make<void>();
      const releaseRunner = yield* Deferred.make<void>();
      let generation = 1;
      let transientPause = false;
      const resumedOutcome = yield* Ref.make("not attempted");
      const resumed = new MateMemoryMaintenance({
        store: resumedFixture.store,
        isPaused: () => transientPause,
        getPauseGeneration: () => generation,
        runner: (request) =>
          Deferred.succeed(runnerStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRunner)),
            Effect.andThen(toolNamed(request.tools, "memory_write_topic")),
            Effect.flatMap((write) => write.execute({
              path: "topics/late.md",
              type: "feedback",
              scope: "captain",
              source_principal: "captain",
              observed_at: "2026-07-28T08:00:00.000Z",
              pinned: false,
              body: "This write must be blocked after resume.",
            }).pipe(Effect.result)),
            Effect.tap((result) =>
              Ref.set(
                resumedOutcome,
                result._tag === "Failure" ? result.failure.message : "wrote",
              )
            ),
            Effect.as({ summary: "finished", touchedPaths: [] }),
          ),
      });
      resumed.captureHumanInput(
        "Remember this only in the original generation",
        "interactive",
      );
      yield* resumed.afterAgentSettled(baseContext());
      yield* Deferred.await(runnerStarted);
      transientPause = true;
      generation += 1;
      transientPause = false;
      generation += 1;
      yield* Deferred.succeed(releaseRunner, undefined);
      yield* resumed.drain(1_000);
      expect(yield* Ref.get(resumedOutcome)).toContain("generation");

      const epochFixture = yield* fixture();
      const epochStarted = yield* Deferred.make<void>();
      const releaseEpoch = yield* Deferred.make<void>();
      const epochOutcome = yield* Ref.make("not attempted");
      const epoch = new MateMemoryMaintenance({
        store: epochFixture.store,
        isPaused: () => false,
        runner: (request) =>
          Deferred.succeed(epochStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseEpoch)),
            Effect.andThen(toolNamed(request.tools, "memory_write_topic")),
            Effect.flatMap((write) => write.execute({
              path: "topics/late.md",
              type: "feedback",
              scope: "captain",
              source_principal: "captain",
              observed_at: "2026-07-28T08:00:00.000Z",
              pinned: false,
              body: "This write must be invalidated.",
            }).pipe(Effect.result)),
            Effect.tap((result) =>
              Ref.set(
                epochOutcome,
                result._tag === "Failure" ? result.failure.message : "wrote",
              )
            ),
            Effect.as({ summary: "finished", touchedPaths: [] }),
          ),
      });
      epoch.captureHumanInput(
        "Remember this while extraction is active",
        "interactive",
      );
      yield* epoch.afterAgentSettled(baseContext());
      yield* Deferred.await(epochStarted);
      epoch.beginDirectMemoryWrite();
      yield* Deferred.succeed(releaseEpoch, undefined);
      yield* epoch.drain(1_000);
      expect(yield* Ref.get(epochOutcome)).toContain("changed");
    })),
  );

  it.effect("runs eligible Dreams, guards schedule markers, and releases failed locks once", () =>
    run(Effect.gen(function*() {
      const successFixture = yield* fixture();
      const activity = yield* eligibleActivity(successFixture.home);
      const requests = yield* Ref.make<ReadonlyArray<MaintenanceRunRequest>>([]);
      const events: Array<{ status: string; summary: string }> = [];
      const maintenance = new MateMemoryMaintenance({
        store: successFixture.store,
        runner: (request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(
            Effect.as({ summary: "merged topics", touchedPaths: [] }),
          ),
        isPaused: () => false,
        now: fixedNow,
        onEvent: (event) => events.push(event),
      });
      yield* maintenance.maybeDream(baseContext(), activity, "current");
      const captured = yield* Ref.get(requests);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.kind).toBe("dream");
      expect(captured[0]?.tools.map(({ name }) => name)).toContain(
        "memory_read_activity",
      );
      expect((yield* activity.readState()).lastSuccessfulDreamAt)
        .toBe("2026-07-28T08:00:00.000Z");
      expect(events).toEqual([{
        status: "succeeded",
        summary: "Dream completed",
      }]);

      const guardedFixture = yield* fixture();
      const realActivity = yield* eligibleActivity(guardedFixture.home);
      let paused = false;
      const guardedActivity: MemoryActivityStore = {
        ...realActivity,
        markDreamDiscovery: (at, options) =>
          Effect.sync(() => {
            paused = true;
          }).pipe(Effect.andThen(realActivity.markDreamDiscovery(at, options))),
      };
      const guarded = new MateMemoryMaintenance({
        store: guardedFixture.store,
        runner: () => Effect.die("Dream runner must not be reached."),
        isPaused: () => paused,
        now: fixedNow,
      });
      yield* guarded.maybeDream(baseContext(), guardedActivity, "current");
      expect((yield* realActivity.readState()).lastDreamDiscoveryAt)
        .toBeUndefined();

      const failedFixture = yield* fixture();
      const failedActivity = yield* eligibleActivity(failedFixture.home);
      const failedEvents: Array<{ status: string; summary: string }> = [];
      const failed = new MateMemoryMaintenance({
        store: failedFixture.store,
        runner: () => Effect.fail(runnerFailure("Dream failed")),
        isPaused: () => false,
        now: fixedNow,
        onEvent: (event) => failedEvents.push(event),
      });
      yield* failed.maybeDream(baseContext(), failedActivity, "current");
      expect((yield* failedActivity.readState()).lastSuccessfulDreamAt)
        .toBeUndefined();
      expect(yield* failedFixture.fileSystem.exists(
        failedFixture.paths.join(
          failedFixture.home,
          "memory",
          ".consolidate-lock",
        ),
      )).toBe(false);
      expect(failedEvents).toEqual([{
        status: "failed",
        summary: "Dream failed",
      }]);
    })),
  );
});
