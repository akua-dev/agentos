import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import type {
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import {
  Crypto,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
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
import type { TopicMetadata } from "../../memory/schema.ts";
import { createFakePi } from "../../../tests/fake-pi.ts";
import {
  registerMateMemoryExtensionEffect,
  type MateMemoryExtensionController,
  type MateMemoryExtensionDependencies,
} from "../extension.ts";
import type {
  MaintenanceRunRequest,
} from "../maintenance.ts";

const platformLayer = Layer.mergeAll(
  BunCrypto.layer,
  BunFileSystem.layer,
  BunPath.layer,
);
const fixedNow = Effect.succeed(new Date("2026-07-28T08:00:00.000Z"));
const BeforeStartResult = Schema.Struct({
  systemPrompt: Schema.String,
  message: Schema.optional(Schema.Struct({
    customType: Schema.String,
    content: Schema.String,
    display: Schema.Boolean,
  })),
});
const BlockResult = Schema.Struct({
  block: Schema.Boolean,
  reason: Schema.String,
});

function run<A, E>(
  effect: Effect.Effect<
    A,
    E,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope
  >,
) {
  return Effect.scoped(effect).pipe(Effect.provide(platformLayer));
}

function fixture(
  overrides: Parameters<typeof createMateMemoryStore>[1] = {},
) {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "agentos-pi-memory-",
    });
    const store = yield* createMateMemoryStore(home, overrides);
    yield* store.ensureLayout();
    yield* store.writeIndex(
      "# Memory index\n- reporting: Captain prefers outcome-first updates\n",
    );
    const metadata: TopicMetadata = {
      node_type: "memory",
      type: "feedback",
      scope: "captain",
      source_principal: "captain",
      observed_at: "2026-07-28T08:00:00.000Z",
      modified: "2026-07-28T08:00:00.000Z",
      pinned: false,
    };
    yield* store.writeTopic({
      relativePath: "topics/reporting.md",
      metadata,
      body: "Lead with the outcome.",
    });
    yield* store.writeTopic({
      relativePath: "topics/agentos.md",
      metadata: { ...metadata, type: "project" },
      body: "AgentOS uses PostgreSQL as durable Fleet truth.",
    });
    yield* store.writeTopic({
      relativePath: "topics/pinned.md",
      metadata: { ...metadata, pinned: true },
      body: "Never merge without exact authority.",
    });
    return { fileSystem, home, paths, store };
  });
}

interface HarnessOptions {
  readonly branch?: ReadonlyArray<unknown>;
  readonly sessionId?: string;
}

function harness(
  dependencies: MateMemoryExtensionDependencies,
  options: HarnessOptions = {},
) {
  return Effect.gen(function*() {
    const fake = createFakePi();
    const tools = new Map<string, ToolDefinition>();
    const entries: Array<{ customType: string; data: unknown }> = [];
    const notifications: string[] = [];
    const state = {
      branch: options.branch ?? [],
      sessionId: options.sessionId ?? "session-1",
    };
    Object.assign(fake.pi, {
      appendEntry(customType: string, data: unknown) {
        entries.push({ customType, data });
      },
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
    });
    Object.assign(fake.context, {
      cwd: "/workspace",
      model: undefined,
      sessionManager: {
        getBranch: () => state.branch,
        getSessionId: () => state.sessionId,
      },
      signal: undefined,
      ui: {
        notify: (message: string) => notifications.push(message),
      },
    });
    const controller = yield* registerMateMemoryExtensionEffect(
      fake.pi,
      dependencies,
    );
    if (controller === undefined) {
      return yield* Effect.die("Mate memory unexpectedly disabled in test.");
    }
    const emit = (name: string, event: Readonly<Record<string, unknown>> = {}) =>
      Effect.tryPromise({
        try: () => fake.emit(name, { type: name, ...event }),
        catch: (cause) => cause,
      }).pipe(Effect.map((results) => results[0]));
    const executeTool = (
      name: string,
      toolCallId: string,
      input: Readonly<Record<string, unknown>>,
    ) => {
      const tool = tools.get(name);
      return tool === undefined
        ? Effect.die(`Missing Pi tool ${name}.`)
        : Effect.tryPromise({
          try: () =>
            tool.execute(
              toolCallId,
              input,
              undefined,
              undefined,
              fake.context,
            ),
          catch: (cause) => cause,
        });
    };
    const setPaused = (paused: boolean) =>
      executeTool(
        "set_mate_memory_state",
        `state-${paused ? "pause" : "resume"}`,
        { action: paused ? "pause" : "resume" },
      );
    return {
      controller,
      emit,
      entries,
      executeTool,
      notifications,
      setPaused,
      state,
      tools,
    };
  });
}

function beforeStart(runtime: {
  readonly emit: (
    name: string,
    event?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, unknown>;
}, prompt = "Recall memory") {
  return runtime.emit("before_agent_start", {
    prompt,
    systemPrompt: "ROLE",
    systemPromptOptions: {},
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(BeforeStartResult)),
    Effect.orDie,
  );
}

function blockResult(value: unknown) {
  return Schema.decodeUnknownEffect(BlockResult)(value).pipe(Effect.orDie);
}

describe("Pi Mate memory Effect extension", () => {
  it.effect("loads bounded startup memory and attaches selected topics once per session", () =>
    run(Effect.gen(function*() {
      const { home, store } = yield* fixture();
      const selections = yield* Ref.make(0);
      const runtime = yield* harness({
        home,
        selectRelevant: () =>
          Ref.update(selections, (count) => count + 1).pipe(
            Effect.as([
              "topics/agentos.md",
              "../escape.md",
              "topics/pinned.md",
            ]),
          ),
      });

      const first = yield* beforeStart(runtime, "How should AgentOS change?");
      expect(first.systemPrompt).toContain(
        "Captain prefers outcome-first updates",
      );
      expect(first.systemPrompt).toContain(
        "Never merge without exact authority.",
      );
      expect(first.message).toMatchObject({
        customType: "agentos-mate-memory-context",
        display: false,
      });
      expect(first.message?.content).toContain(
        "AgentOS uses PostgreSQL as durable Fleet truth.",
      );
      expect(first.message?.content).not.toContain("pinned.md");
      expect((yield* beforeStart(runtime, "Continue")).message).toBeUndefined();
      yield* runtime.emit("session_start");
      expect((yield* beforeStart(runtime, "New session")).message).toBeDefined();
      expect(yield* Ref.get(selections)).toBe(3);

      for (let index = 0; index < 7; index += 1) {
        yield* store.writeTopic({
          relativePath: `topics/item-${index}.md`,
          metadata: {
            node_type: "memory",
            type: "reference",
            scope: "fleet",
            source_principal: "captain",
            observed_at: "2026-07-28T08:00:00.000Z",
            modified: "2026-07-28T08:00:00.000Z",
            pinned: false,
          },
          body: "x".repeat(260),
        });
      }
      const capped = yield* harness({
        home,
        policy: {
          maxRelevantTopics: 5,
          maxSessionAttachmentBytes: 900,
        },
        selectRelevant: () =>
          Effect.succeed(
            Array.from(
              { length: 7 },
              (_, index) => `topics/item-${index}.md`,
            ),
          ),
      });
      const content = (yield* beforeStart(capped)).message?.content ?? "";
      expect((content.match(/^## topics\//gm) ?? []).length)
        .toBeLessThanOrEqual(5);
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(900);

      const pinned = yield* store.readTopic("topics/pinned.md");
      yield* store.writeTopic({
        relativePath: pinned.relativePath,
        metadata: pinned.metadata,
        body: "p".repeat(2_000),
      });
      const boundedPinned = yield* harness({
        home,
        policy: { maxSessionAttachmentBytes: 700 },
        selectRelevant: () => Effect.succeed(["topics/agentos.md"]),
      });
      const loaded = yield* beforeStart(boundedPinned);
      expect(loaded.systemPrompt).not.toContain("p".repeat(100));
      expect(loaded.systemPrompt).toContain(
        "pinned topic topics/pinned.md exceeds the remaining attachment budget",
      );
      expect(loaded.message?.content).toContain(
        "AgentOS uses PostgreSQL as durable Fleet truth.",
      );
    })),
  );

  it.effect("pauses recall, native memory I/O, and activity, then restores session state", () =>
    run(Effect.gen(function*() {
      const { home, paths } = yield* fixture();
      const runtime = yield* harness({
        home,
        now: fixedNow,
        selectRelevant: () => Effect.succeed(["topics/agentos.md"]),
      }, { sessionId: "paused-activity" });
      yield* runtime.emit("tool_call", {
        toolCallId: "before-pause",
        toolName: "read",
        input: {},
      });
      yield* runtime.setPaused(true);
      expect(runtime.entries.at(-1)).toEqual({
        customType: "agentos-mate-memory-state",
        data: { paused: true },
      });
      expect((yield* beforeStart(runtime)).systemPrompt).toBe("ROLE");

      const memoryIndex = paths.join(home, "memory", "MEMORY.md");
      expect(yield* blockResult(yield* runtime.emit("tool_call", {
        toolCallId: "write-1",
        toolName: "write",
        input: { path: memoryIndex, content: "replace" },
      }))).toEqual({
        block: true,
        reason: "Mate memory is paused for this Pi session.",
      });
      expect(yield* blockResult(yield* runtime.emit("tool_call", {
        toolCallId: "read-1",
        toolName: "read",
        input: { path: memoryIndex },
      }))).toEqual({
        block: true,
        reason: "Mate memory is paused for this Pi session.",
      });
      yield* runtime.emit("input", {
        text: "Human input while paused",
        source: "interactive",
      });
      yield* runtime.emit("agent_end", {
        messages: [{
          role: "assistant",
          content: [{ type: "text", text: "Assistant output while paused" }],
        }],
      });
      expect(yield* runtime.controller.activity.readRecent(3)).toBe("");

      yield* runtime.setPaused(false);
      yield* runtime.emit("input", {
        text: "Human input after resume",
        source: "interactive",
      });
      yield* runtime.emit("tool_call", {
        toolCallId: "after-resume",
        toolName: "grep",
        input: {},
      });
      yield* runtime.emit("agent_end", {
        messages: [{
          role: "assistant",
          content: [{ type: "text", text: "Assistant output after resume" }],
        }],
      });
      const resumed = yield* runtime.controller.activity.readRecent(3);
      expect(resumed).toContain("Human input after resume");
      expect(resumed).toContain(". grep");
      expect(resumed).toContain("Assistant output after resume");
      expect(resumed).not.toContain("Human input while paused");
      expect(resumed).not.toContain("Assistant output while paused");
      expect(resumed).not.toContain(". read");

      const realActivity = yield* createMemoryActivityStore(home);
      const calls: string[] = [];
      const observedActivity: MemoryActivityStore = {
        ...realActivity,
        ensureState: (at) =>
          Effect.sync(() => calls.push("ensureState")).pipe(
            Effect.andThen(realActivity.ensureState(at)),
          ),
        completeSession: (sessionId, at) =>
          Effect.sync(() => calls.push("completeSession")).pipe(
            Effect.andThen(realActivity.completeSession(sessionId, at)),
          ),
      };
      const restored = yield* harness({
        home,
        activity: observedActivity,
      }, {
        branch: [{
          type: "custom",
          customType: "agentos-mate-memory-state",
          data: { paused: true },
        }],
        sessionId: "restored-paused",
      });
      yield* restored.emit("session_start");
      yield* restored.emit("session_shutdown");
      expect((yield* beforeStart(restored)).systemPrompt).toBe("ROLE");
      expect(calls).toEqual([]);
    })),
  );

  it.effect("fails closed across selection, append, and capacity-check pause races", () =>
    run(Effect.gen(function*() {
      const selectionFixture = yield* fixture();
      const selectionStarted = yield* Deferred.make<void>();
      const releaseSelection = yield* Deferred.make<void>();
      const selectionRuntime = yield* harness({
        home: selectionFixture.home,
        selectRelevant: () =>
          Deferred.succeed(selectionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSelection)),
            Effect.as(["topics/agentos.md"]),
          ),
      });
      const recall = yield* Effect.forkChild(beforeStart(selectionRuntime));
      yield* Deferred.await(selectionStarted);
      yield* selectionRuntime.setPaused(true);
      yield* Deferred.succeed(releaseSelection, undefined);
      expect((yield* Fiber.join(recall)).systemPrompt).toBe("ROLE");

      const appendFixture = yield* fixture();
      const realActivity = yield* createMemoryActivityStore(
        appendFixture.home,
        { now: fixedNow },
      );
      const appendStarted = yield* Deferred.make<void>();
      const releaseAppend = yield* Deferred.make<void>();
      const delayedActivity: MemoryActivityStore = {
        ...realActivity,
        append: (sessionId, projection, options) =>
          Deferred.succeed(appendStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseAppend)),
            Effect.andThen(realActivity.append(sessionId, projection, options)),
          ),
      };
      const appendRuntime = yield* harness({
        home: appendFixture.home,
        activity: delayedActivity,
      }, { sessionId: "pause-race" });
      const input = yield* Effect.forkChild(
        appendRuntime.emit("input", {
          text: "This must not survive pause",
          source: "interactive",
        }),
      );
      yield* Deferred.await(appendStarted);
      yield* appendRuntime.setPaused(true);
      yield* Deferred.succeed(releaseAppend, undefined);
      yield* Fiber.join(input);
      expect(yield* realActivity.readRecent(3)).toBe("");

      const capacityFixture = yield* fixture();
      yield* capacityFixture.store.deleteTopic("topics/reporting.md");
      yield* capacityFixture.store.deleteTopic("topics/agentos.md");
      const capacityStore = yield* createMateMemoryStore(
        capacityFixture.home,
        { maxTopicFiles: 2 },
      );
      const capacity = yield* harness({
        home: capacityFixture.home,
        store: capacityStore,
      });
      expect(yield* capacity.emit("tool_call", {
        toolCallId: "new-a",
        toolName: "write",
        input: {
          path: capacityFixture.paths.join(
            capacityFixture.home,
            "memory",
            "topics",
            "new-a.md",
          ),
        },
      })).toBeUndefined();
      expect(yield* blockResult(yield* capacity.emit("tool_call", {
        toolCallId: "new-b",
        toolName: "write",
        input: {
          path: capacityFixture.paths.join(
            capacityFixture.home,
            "memory",
            "topics",
            "new-b.md",
          ),
        },
      }))).toEqual({
        block: true,
        reason: "Mate memory has reached its 2-topic limit.",
      });
      yield* capacity.emit("tool_result", {
        toolCallId: "new-a",
        toolName: "write",
        input: {},
        content: [],
        details: {},
        isError: true,
      });
      expect(yield* capacity.emit("tool_call", {
        toolCallId: "new-c",
        toolName: "write",
        input: {
          path: capacityFixture.paths.join(
            capacityFixture.home,
            "memory",
            "topics",
            "new-c.md",
          ),
        },
      })).toBeUndefined();

      const checkFixture = yield* fixture({ maxTopicFiles: 4 });
      const listStarted = yield* Deferred.make<void>();
      const releaseList = yield* Deferred.make<void>();
      const delayedStore: MateMemoryStore = {
        ...checkFixture.store,
        listTopics: (options) =>
          Deferred.succeed(listStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseList)),
            Effect.andThen(checkFixture.store.listTopics(options)),
          ),
      };
      const checked = yield* harness({
        home: checkFixture.home,
        store: delayedStore,
      });
      const call = yield* Effect.forkChild(
        checked.emit("tool_call", {
          toolCallId: "pause-race-write",
          toolName: "write",
          input: {
            path: checkFixture.paths.join(
              checkFixture.home,
              "memory",
              "topics",
              "new.md",
            ),
          },
        }),
      );
      yield* Deferred.await(listStarted);
      yield* checked.setPaused(true);
      yield* Deferred.succeed(releaseList, undefined);
      expect(yield* blockResult(yield* Fiber.join(call))).toEqual({
        block: true,
        reason: "Mate memory is paused for this Pi session.",
      });
    })),
  );

  it.effect("reserves native capacity, validates edits, and forgets only exact topics", () =>
    run(Effect.gen(function*() {
      const { fileSystem, home, paths, store } = yield* fixture();
      const directWrites: string[] = [];
      const runtime = yield* harness({
        home,
        now: Effect.succeed(new Date("2026-07-28T10:00:00.000Z")),
        onDirectMemoryWrite: (path) => directWrites.push(path),
      });
      const topicPath = paths.join(home, "memory", "topics", "reporting.md");
      expect(yield* runtime.emit("tool_call", {
        toolCallId: "edit-1",
        toolName: "edit",
        input: { path: topicPath, oldText: "outcome", newText: "result" },
      })).toBeUndefined();
      yield* fileSystem.readFileString(topicPath).pipe(
        Effect.flatMap((source) =>
          fileSystem.writeFileString(
            topicPath,
            source.replace("outcome", "result"),
          )
        ),
      );
      expect(yield* runtime.emit("tool_result", {
        toolCallId: "edit-1",
        toolName: "edit",
        input: { path: topicPath },
        content: [{ type: "text", text: "edited" }],
        details: {},
        isError: false,
      })).toBeUndefined();
      expect(yield* fileSystem.readFileString(topicPath)).toContain(
        "modified: 2026-07-28T10:00:00.000Z",
      );
      expect(directWrites).toEqual(["topics/reporting.md"]);

      yield* runtime.executeTool(
        "memory_delete_topic",
        "forget-1",
        { path: "topics/reporting.md" },
      );
      expect((yield* store.readTopic("topics/reporting.md").pipe(Effect.flip)).code)
        .toBe("io_failed");
      expect(yield* fileSystem.readFileString(
        paths.join(home, "memory", "MEMORY.md"),
      )).toContain("reporting");
      expect(runtime.controller.isPaused()).toBe(false);
    })),
  );

  it.effect("guards startup bootstrap and keeps unsafe memory roots degradable", () =>
    run(Effect.gen(function*() {
      const readFixture = yield* fixture();
      const reads = yield* Ref.make(0);
      let readRuntime: {
        readonly setPaused: (paused: boolean) => Effect.Effect<unknown, unknown>;
      } | undefined;
      const guardedStore: MateMemoryStore = {
        ...readFixture.store,
        readStartupContext: (options = {}) =>
          readFixture.store.readStartupContext({
            ...options,
            beforeRead: Ref.updateAndGet(reads, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 2 && readRuntime !== undefined
                  ? readRuntime.setPaused(true)
                  : Effect.void
              ),
              Effect.andThen(options.beforeRead ?? Effect.void),
            ),
          }),
      };
      const guarded = yield* harness({
        home: readFixture.home,
        store: guardedStore,
      });
      readRuntime = guarded;
      expect((yield* beforeStart(guarded)).systemPrompt).toBe("ROLE");
      expect(yield* Ref.get(reads)).toBe(2);

      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const bootstrapHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-pi-memory-bootstrap-",
      });
      const bootstrapStore = yield* createMateMemoryStore(bootstrapHome);
      let bootstrapRuntime: {
        readonly setPaused: (paused: boolean) => Effect.Effect<unknown, unknown>;
      } | undefined;
      const guardedBootstrap: MateMemoryStore = {
        ...bootstrapStore,
        readStartupContext: (options = {}) =>
          bootstrapStore.readStartupContext({
            ...options,
            beforeCommit: (bootstrapRuntime === undefined
              ? Effect.void
              : bootstrapRuntime.setPaused(true)).pipe(
                Effect.andThen(options.beforeCommit ?? Effect.void),
              ),
          }),
      };
      const bootstrap = yield* harness({
        home: bootstrapHome,
        store: guardedBootstrap,
      });
      bootstrapRuntime = bootstrap;
      expect((yield* beforeStart(bootstrap, "Bootstrap memory")).systemPrompt)
        .toBe("ROLE");
      expect(yield* fileSystem.exists(
        paths.join(bootstrapHome, "memory", "MEMORY.md"),
      )).toBe(false);

      const unsafeHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-pi-memory-unsafe-",
      });
      const outside = paths.join(unsafeHome, "outside");
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.symlink(outside, paths.join(unsafeHome, "memory"));
      const unsafe = yield* harness({ home: unsafeHome }, {
        sessionId: "unsafe-root",
      });
      yield* unsafe.emit("session_start");
      expect((yield* beforeStart(
        unsafe,
        "Handle an urgent Inbox event",
      )).systemPrompt).toContain("Mate memory is unavailable");
    })),
  );

  it.effect("connects only direct human input after a blocked native preflight", () =>
    run(Effect.gen(function*() {
      const { home, paths, store } = yield* fixture({ maxTopicFiles: 3 });
      const requests = yield* Ref.make<ReadonlyArray<MaintenanceRunRequest>>([]);
      const runtime = yield* harness({
        home,
        store,
        maintenanceRunner: (request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(
            Effect.as({ summary: "nothing to save", touchedPaths: [] }),
          ),
      }, { sessionId: "direct-human" });
      const blocked = yield* runtime.emit("tool_call", {
        toolCallId: "blocked-write",
        toolName: "write",
        input: {
          path: paths.join(home, "memory", "topics", "new.md"),
        },
      });
      expect(yield* blockResult(blocked)).toEqual({
        block: true,
        reason: "Mate memory has reached its 3-topic limit.",
      });
      yield* runtime.emit("input", {
        text: "Remember concise result summaries",
        source: "interactive",
      });
      yield* runtime.emit("input", {
        text: "Internal extension maintenance message",
        source: "extension",
      });
      yield* runtime.emit("agent_settled");
      yield* runtime.controller.maintenance.drain(1_000);
      yield* runtime.controller.maintenance.shutdown(1_000);
      const captured = yield* Ref.get(requests);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.prompt).toContain(
        "Remember concise result summaries",
      );
      expect(captured[0]?.prompt).not.toContain("Internal extension");
    })),
  );
});
