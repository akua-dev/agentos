import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  Clock,
  Config,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
} from "effect";

import {
  createMemoryActivityStore,
  type MemoryActivityStore,
} from "../memory/activity.ts";
import type { MateMemoryPolicy } from "../memory/policy.ts";
import {
  createMateMemoryStore,
  type MateMemoryStore,
  type StartupMemoryContext,
  type StoredTopic,
} from "../memory/store.ts";
import { environmentConfigLayer } from "../shared/platform.ts";
import { runAgentOSPiProgram } from "../pi-host-adapter.ts";
import type { AgentOSTelemetrySource } from "../telemetry/auxiliary.ts";
import type { AgentOSTelemetryRuntime } from "../telemetry/runtime-context.ts";
import {
  MateMemoryMaintenance,
  type MaintenanceAgentRunner,
} from "./maintenance.ts";
import {
  selectRelevantTopics,
  type RelevantTopicSelector,
} from "./model.ts";
import {
  relevantMemoryMessage,
  startupSystemPrompt,
} from "./prompts.ts";

const STATE_ENTRY = "agentos-mate-memory-state";
const CONTEXT_MESSAGE = "agentos-mate-memory-context";
const MEMORY_TOOL = "set_mate_memory_state";
const nativeFileTools = new Set(["read", "write", "edit"]);
const nativeWriteTools = new Set(["write", "edit"]);

export interface MateMemoryExtensionDependencies {
  readonly home?: string;
  readonly policy?: Partial<MateMemoryPolicy>;
  readonly selectRelevant?: RelevantTopicSelector;
  readonly now?: Effect.Effect<Date>;
  readonly onDirectMemoryWrite?: (relativePath: string) => void;
  readonly store?: MateMemoryStore;
  readonly activity?: MemoryActivityStore;
  readonly maintenanceRunner?: MaintenanceAgentRunner;
  readonly telemetry?: AgentOSTelemetrySource;
  readonly telemetryRuntime?: AgentOSTelemetryRuntime;
}

interface PendingNativeWrite {
  readonly relativePath: string;
  readonly existedBeforeCall: boolean;
}

const ExtensionErrorCode = Schema.Literals([
  "activity_failed",
  "configuration_failed",
  "home_unavailable",
  "inactive",
  "io_failed",
  "maintenance_failed",
  "path_invalid",
  "selection_failed",
  "store_failed",
]);

export class MateMemoryExtensionError extends Schema.TaggedErrorClass<MateMemoryExtensionError>()(
  "MateMemoryExtensionError",
  {
    cause: Schema.Unknown,
    code: ExtensionErrorCode,
    message: Schema.String,
  },
) {}

export interface MateMemoryExtensionController {
  readonly isPaused: () => boolean;
  readonly store: MateMemoryStore;
  readonly maintenance: MateMemoryMaintenance;
  readonly activity: MemoryActivityStore;
}

const platformLayer = Layer.mergeAll(
  BunCrypto.layer,
  BunFileSystem.layer,
  BunPath.layer,
);

function extensionError(
  code: MateMemoryExtensionError["code"],
  message: string,
  cause: unknown = message,
) {
  return MateMemoryExtensionError.make({ cause, code, message });
}

function mapFailure(
  code: MateMemoryExtensionError["code"],
  message: string,
) {
  return (cause: unknown) => extensionError(code, message, cause);
}

function defaultNow() {
  return Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis)));
}

function resolveAuth(context: ExtensionContext) {
  const model = context.model;
  return model === undefined
    ? Effect.succeed({ ok: false, error: "no active model" })
    : Effect.tryPromise({
      try: () => context.modelRegistry.getApiKeyAndHeaders(model),
      catch: (cause) => cause,
    });
}

export function registerMateMemoryExtensionEffect(
  pi: ExtensionAPI,
  dependencies: MateMemoryExtensionDependencies = {},
): Effect.Effect<
  MateMemoryExtensionController | undefined,
  MateMemoryExtensionError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function*() {
    const disabled = yield* Config.string("AGENTOS_DISABLE_MATE_MEMORY").pipe(
      Config.withDefault(""),
      Effect.map((value) => value.trim().toLowerCase() === "true"),
      Effect.mapError(mapFailure("configuration_failed", "Mate memory configuration is unavailable.")),
    );
    if (disabled) return undefined;
    const configuredHome = yield* Config.option(Config.string("HOME")).pipe(
      Effect.mapError(mapFailure("configuration_failed", "Mate home configuration is unavailable.")),
    );
    const home = dependencies.home ?? Option.getOrUndefined(configuredHome);
    if (home === undefined || home.trim() === "") {
      return yield* extensionError(
        "home_unavailable",
        "HOME must point at the mounted Mate home",
      );
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const store = dependencies.store ??
      (yield* createMateMemoryStore(home, dependencies.policy));
    const selector = dependencies.selectRelevant ?? selectRelevantTopics;
    const now = dependencies.now ?? defaultNow();
    const activity = dependencies.activity ??
      (yield* createMemoryActivityStore(home, { now }));
    const attached = new Set<string>();
    const pendingWrites = new Map<string, PendingNativeWrite>();
    const pendingTopicCreations = new Set<string>();
    const observedToolNames = new Set<string>();
    let attachedBytes = 0;
    let paused = false;
    let pauseGeneration = 0;

    const recordFailure = (summary: string) =>
      Effect.sync(() =>
        pi.appendEntry("agentos-mate-memory-maintenance", {
          status: "failed",
          summary,
        })
      );
    const isActiveGeneration = (generation: number) =>
      !paused && generation === pauseGeneration;
    const assertMemoryGeneration = (generation: number) =>
      Effect.suspend(() =>
        isActiveGeneration(generation)
          ? Effect.void
          : Effect.fail(
            extensionError(
              "inactive",
              "Mate memory is paused for this Pi session.",
            ),
          )
      );
    const setPaused = (value: boolean) =>
      Effect.sync(() => {
        pauseGeneration += 1;
        paused = value;
        if (value) {
          observedToolNames.clear();
          pendingWrites.clear();
          pendingTopicCreations.clear();
        }
        pi.appendEntry(STATE_ENTRY, { paused });
      });

    const maintenance = new MateMemoryMaintenance({
      store,
      runner: dependencies.maintenanceRunner,
      isPaused: () => paused,
      getPauseGeneration: () => pauseGeneration,
      now,
      onEvent: (event) =>
        pi.appendEntry("agentos-mate-memory-maintenance", event),
    });

    pi.on("session_start", (_event, context) =>
      runAgentOSPiProgram(Effect.gen(function*() {
        yield* Effect.sync(() => {
          attached.clear();
          attachedBytes = 0;
          pendingWrites.clear();
          pendingTopicCreations.clear();
          observedToolNames.clear();
          pauseGeneration += 1;
          paused = restoredPauseState(context);
        });
        if (paused) return;
        const timestamp = yield* now;
        yield* activity.ensureState(timestamp).pipe(
          Effect.catch((error) =>
            recordFailure(`activity state is unavailable: ${error.message}`)
          ),
        );
      }))
    );

    pi.on("input", (event, context) =>
      runAgentOSPiProgram(Effect.gen(function*() {
        yield* Effect.sync(() =>
          maintenance.captureHumanInput(event.text, event.source)
        );
        const generation = pauseGeneration;
        if (paused || event.source === "extension") return;
        yield* activity.append(
          context.sessionManager.getSessionId(),
          { kind: "human", text: event.text },
          { beforeCommit: assertMemoryGeneration(generation) },
        ).pipe(
          Effect.catch((error) =>
            recordFailure(`activity projection failed: ${error.message}`)
          ),
        );
      }))
    );

    pi.on("agent_settled", (_event, context) =>
      runAgentOSPiProgram(Effect.gen(function*() {
        const maintenanceContext = {
          agentDir: paths.resolve(home, ".pi", "agent"),
          cwd: context.cwd,
          model: context.model,
          resolveAuth: resolveAuth(context),
          signal: context.signal,
          telemetry: dependencies.telemetry,
          telemetryRuntime: dependencies.telemetryRuntime,
        };
        yield* maintenance.afterAgentSettled(maintenanceContext);
        yield* maintenance.maybeDream(
          maintenanceContext,
          activity,
          context.sessionManager.getSessionId(),
        ).pipe(Effect.forkDetach);
      }))
    );

    pi.on("agent_end", (event, context) =>
      runAgentOSPiProgram(Effect.gen(function*() {
        const sessionId = context.sessionManager.getSessionId();
        const generation = pauseGeneration;
        const projection = Effect.gen(function*() {
          if (!isActiveGeneration(generation)) return;
          for (const toolName of [...observedToolNames].sort()) {
            if (!isActiveGeneration(generation)) return;
            yield* activity.append(
              sessionId,
              { kind: "tool", toolName },
              { beforeCommit: assertMemoryGeneration(generation) },
            );
          }
          if (!isActiveGeneration(generation)) return;
          const assistant = [...event.messages]
            .reverse()
            .find((message) => message.role === "assistant");
          if (assistant === undefined || assistant.role !== "assistant") return;
          const text = assistant.content
            .flatMap((part) => part.type === "text" ? [part.text] : [])
            .join("")
            .trim();
          if (text) {
            yield* activity.append(
              sessionId,
              { kind: "assistant", text },
              { beforeCommit: assertMemoryGeneration(generation) },
            );
          }
        }).pipe(
          Effect.catch((error) =>
            recordFailure(`activity projection failed: ${error.message}`)
          ),
          Effect.ensuring(Effect.sync(() => observedToolNames.clear())),
        );
        yield* projection;
      }))
    );

    pi.on("session_shutdown", (_event, context) =>
      runAgentOSPiProgram(Effect.gen(function*() {
        if (!paused) {
          const timestamp = yield* now;
          yield* activity.completeSession(
            context.sessionManager.getSessionId(),
            timestamp,
          ).pipe(
            Effect.catch((error) =>
              recordFailure(
                `session activity completion failed: ${error.message}`,
              )
            ),
          );
        }
        yield* maintenance.shutdown(60_000).pipe(
          Effect.mapError(mapFailure("maintenance_failed", "Mate memory maintenance shutdown failed.")),
        );
      }))
    );

    pi.on("before_agent_start", (event, context) =>
      runAgentOSPiProgram(Effect.gen(function*() {
        const generation = pauseGeneration;
        if (!isActiveGeneration(generation) || !store.policy.enabled) {
          return { systemPrompt: event.systemPrompt };
        }
        const startupResult = yield* store.readStartupContext({
          beforeRead: assertMemoryGeneration(generation),
          beforeCommit: assertMemoryGeneration(generation),
        }).pipe(Effect.result);
        const startup: StartupMemoryContext = Result.isSuccess(startupResult)
          ? startupResult.success
          : {
            index: "",
            pinned: [],
            inventory: [],
            degraded: [
              `Mate memory is unavailable: ${startupResult.failure.message}`,
            ],
          };
        if (!isActiveGeneration(generation)) {
          return { systemPrompt: event.systemPrompt };
        }
        const boundedPinned: StoredTopic[] = [];
        let pinnedBytes = 0;
        for (const topic of startup.pinned) {
          const bytes = formattedTopicBytes(topic);
          if (pinnedBytes + bytes > store.policy.maxSessionAttachmentBytes) {
            startup.degraded.push(
              `pinned topic ${topic.relativePath} exceeds the remaining attachment budget`,
            );
            continue;
          }
          boundedPinned.push(topic);
          pinnedBytes += bytes;
        }
        startup.pinned = boundedPinned;
        attachedBytes = Math.max(attachedBytes, pinnedBytes);
        const selected: StoredTopic[] = [];
        const selection = Effect.gen(function*() {
          const selectedPaths = yield* selector({
            prompt: event.prompt,
            startup,
            model: context.model,
            resolveAuth: resolveAuth(context),
            signal: context.signal,
            telemetry: dependencies.telemetry,
            telemetryRuntime: dependencies.telemetryRuntime,
          });
          const allowed = new Set(
            startup.inventory
              .filter(({ pinned }) => !pinned)
              .map(({ relativePath }) => relativePath),
          );
          for (const path of selectedPaths) {
            if (!isActiveGeneration(generation)) {
              return yield* extensionError(
                "inactive",
                "Mate memory recall crossed a pause transition.",
              );
            }
            if (
              selected.length >= store.policy.maxRelevantTopics ||
              !allowed.has(path) ||
              attached.has(path)
            ) continue;
            const topic = yield* store.readTopic(path, {
              beforeRead: assertMemoryGeneration(generation),
            });
            if (!isActiveGeneration(generation)) {
              return yield* extensionError(
                "inactive",
                "Mate memory recall crossed a pause transition.",
              );
            }
            const candidate = relevantMemoryMessage([...selected, topic]);
            if (
              attachedBytes + Buffer.byteLength(candidate) >
              store.policy.maxSessionAttachmentBytes
            ) continue;
            selected.push(topic);
          }
        });
        const selectionResult = yield* selection.pipe(Effect.result);
        if (Result.isFailure(selectionResult)) {
          if (!isActiveGeneration(generation)) {
            return { systemPrompt: event.systemPrompt };
          }
          startup.degraded.push(
            `relevant-memory selection failed: ${selectionResult.failure.message}`,
          );
        }
        if (!isActiveGeneration(generation)) {
          return { systemPrompt: event.systemPrompt };
        }
        const systemPrompt = startupSystemPrompt(event.systemPrompt, startup);
        if (selected.length === 0) return { systemPrompt };
        const content = relevantMemoryMessage(selected);
        attachedBytes += Buffer.byteLength(content);
        for (const topic of selected) attached.add(topic.relativePath);
        return {
          systemPrompt,
          message: {
            customType: CONTEXT_MESSAGE,
            content,
            display: false,
            details: {
              paths: selected.map(({ relativePath }) => relativePath),
            },
          },
        };
      }))
    );

    const nativePathExists = (
      path: string,
      beforeRead: Effect.Effect<void, MateMemoryExtensionError>,
    ) =>
      Effect.gen(function*() {
        yield* beforeRead;
        const link = yield* fileSystem.readLink(path).pipe(Effect.option);
        if (Option.isSome(link)) {
          return yield* extensionError(
            "path_invalid",
            `memory path crosses symbolic link ${path}`,
          );
        }
        const stat = yield* fileSystem.stat(path).pipe(Effect.result);
        yield* beforeRead;
        if (Result.isSuccess(stat)) return true;
        const tag = platformTag(stat.failure);
        if (tag === "NotFound") return false;
        return yield* extensionError(
          "io_failed",
          `Mate memory path could not be inspected: ${path}`,
          stat.failure,
        );
      });

    pi.on("tool_call", (event, context) =>
      runAgentOSPiProgram(Effect.gen(function*() {
        const generation = pauseGeneration;
        if (!paused) observedToolNames.add(event.toolName);
        if (!nativeFileTools.has(event.toolName)) return;
        const target = nativeToolPath(event, context, paths);
        if (target === undefined || !isWithin(store.root, target, paths)) return;
        if (!isActiveGeneration(generation)) return pausedMemoryToolResult();
        const relative = memoryRelativePath(store.root, target, paths);
        if (Result.isFailure(relative)) {
          return {
            block: true,
            reason: `Unsafe Mate memory path: ${relative.failure.message}`,
          };
        }
        const relativePath = relative.success;
        const resolved = yield* store.resolveMemoryPath(relativePath, {
          beforeRead: assertMemoryGeneration(generation),
        }).pipe(Effect.result);
        if (Result.isFailure(resolved)) {
          if (!isActiveGeneration(generation)) return pausedMemoryToolResult();
          return {
            block: true,
            reason: `Unsafe Mate memory path: ${resolved.failure.message}`,
          };
        }
        if (!isActiveGeneration(generation)) return pausedMemoryToolResult();
        if (!nativeWriteTools.has(event.toolName)) return;
        const existed = yield* nativePathExists(
          target,
          assertMemoryGeneration(generation),
        ).pipe(Effect.result);
        if (Result.isFailure(existed)) {
          if (!isActiveGeneration(generation)) return pausedMemoryToolResult();
          return yield* existed.failure;
        }
        if (!isActiveGeneration(generation)) return pausedMemoryToolResult();
        if (!existed.success && relativePath.startsWith("topics/")) {
          const topics = yield* store.listTopics({
            beforeRead: assertMemoryGeneration(generation),
            beforeCommit: assertMemoryGeneration(generation),
          }).pipe(Effect.result);
          if (Result.isFailure(topics)) {
            if (!isActiveGeneration(generation)) return pausedMemoryToolResult();
            return yield* extensionError(
              "store_failed",
              topics.failure.message,
              topics.failure,
            );
          }
          if (!isActiveGeneration(generation)) return pausedMemoryToolResult();
          if (
            topics.success.length + pendingTopicCreations.size >=
            store.policy.maxTopicFiles
          ) {
            return {
              block: true,
              reason: `Mate memory has reached its ${store.policy.maxTopicFiles}-topic limit.`,
            };
          }
          pendingTopicCreations.add(event.toolCallId);
        }
        maintenance.beginDirectMemoryWrite();
        pendingWrites.set(event.toolCallId, {
          relativePath,
          existedBeforeCall: existed.success,
        });
      }))
    );

    pi.on("tool_result", (event) =>
      runAgentOSPiProgram(Effect.gen(function*() {
        const generation = pauseGeneration;
        const pending = pendingWrites.get(event.toolCallId);
        if (pending === undefined) return;
        pendingWrites.delete(event.toolCallId);
        if (!pending.existedBeforeCall) pendingTopicCreations.delete(event.toolCallId);
        if (event.isError || !isActiveGeneration(generation)) return;
        const validation = Effect.gen(function*() {
          if (pending.relativePath === "MEMORY.md") {
            const startup = yield* store.readStartupContext({
              beforeRead: assertMemoryGeneration(generation),
              beforeCommit: assertMemoryGeneration(generation),
            });
            if (!isActiveGeneration(generation)) return;
            const warnings = startup.degraded.filter((warning) =>
              warning.startsWith("MEMORY.md")
            );
            if (warnings.length > 0) {
              return yield* extensionError(
                "store_failed",
                warnings.join("; "),
              );
            }
          } else {
            const timestamp = yield* now;
            yield* store.validateAndStamp(pending.relativePath, {
              now: timestamp,
              enforceTopicLimit: !pending.existedBeforeCall,
              beforeRead: assertMemoryGeneration(generation),
              beforeCommit: assertMemoryGeneration(generation),
            });
          }
          if (!isActiveGeneration(generation)) return;
          yield* Effect.sync(() =>
            dependencies.onDirectMemoryWrite?.(pending.relativePath)
          );
        });
        const result = yield* validation.pipe(Effect.result);
        return Result.isFailure(result)
          ? failedToolResult(event, result.failure)
          : undefined;
      }))
    );

    pi.registerCommand("memory", {
      description: "Pause, resume, or inspect Mate memory for this Pi session",
      handler: (args, context) =>
        runAgentOSPiProgram(Effect.gen(function*() {
          const action = args.trim().toLowerCase() || "status";
          if (action === "pause") yield* setPaused(true);
          else if (action === "resume") yield* setPaused(false);
          else if (action !== "status") {
            yield* Effect.sync(() =>
              context.ui.notify("Usage: /memory pause|resume|status", "error")
            );
            return;
          }
          yield* Effect.sync(() =>
            context.ui.notify(
              paused
                ? "Mate memory is paused for this Pi session."
                : "Mate memory is active for this Pi session.",
              "info",
            )
          );
        })),
    });

    pi.registerTool({
      name: MEMORY_TOOL,
      label: "Set Mate memory state",
      description: "Pause, resume, or inspect private Mate memory for only the current Pi session.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("pause"),
          Type.Literal("resume"),
          Type.Literal("status"),
        ]),
      }),
      execute: (_toolCallId, { action }) =>
        runAgentOSPiProgram(Effect.gen(function*() {
          if (action === "pause") yield* setPaused(true);
          else if (action === "resume") yield* setPaused(false);
          return {
            content: [{
              type: "text",
              text: paused
                ? "Mate memory is paused for this Pi session."
                : "Mate memory is active for this Pi session.",
            }],
            details: { paused },
          };
        })),
    });

    pi.registerTool({
      name: "memory_delete_topic",
      label: "Forget a memory topic",
      description: "Forget one private Mate memory topic. This safe topic-scoped delete does not edit MEMORY.md; use Pi's native exact edit on MEMORY.md to remove its retrieval hook afterward.",
      parameters: Type.Object({
        path: Type.String({
          minLength: 1,
          maxLength: 512,
          pattern: "^topics/[a-z0-9][a-z0-9._/-]*\\.md$",
        }),
      }),
      execute: (_toolCallId, { path }) =>
        runAgentOSPiProgram(Effect.gen(function*() {
          const generation = pauseGeneration;
          yield* assertMemoryGeneration(generation);
          const relativePath = yield* canonicalTopicPath(path);
          yield* store.resolveMemoryPath(relativePath, {
            beforeRead: assertMemoryGeneration(generation),
          });
          yield* assertMemoryGeneration(generation);
          maintenance.beginDirectMemoryWrite();
          yield* store.deleteTopic(relativePath, {
            beforeRead: assertMemoryGeneration(generation),
            beforeCommit: assertMemoryGeneration(generation),
          });
          yield* assertMemoryGeneration(generation);
          yield* Effect.sync(() =>
            dependencies.onDirectMemoryWrite?.(relativePath)
          );
          return {
            content: [{ type: "text", text: `Deleted ${relativePath}.` }],
            details: { relativePath },
          };
        })),
    });

    return {
      isPaused: () => paused,
      store,
      maintenance,
      activity,
    } satisfies MateMemoryExtensionController;
  });
}

export const registerMateMemoryExtensionLiveEffect = Effect.fn(
  "agentos.mateMemory.registerLive",
)(function*(
  pi: ExtensionAPI,
  dependencies: MateMemoryExtensionDependencies = {},
) {
  return yield* (
    registerMateMemoryExtensionEffect(pi, dependencies).pipe(
      Effect.provide(platformLayer),
      Effect.provide(environmentConfigLayer()),
    )
  );
});

export function registerMateMemoryExtension(
  pi: ExtensionAPI,
  dependencies: MateMemoryExtensionDependencies = {},
): Promise<MateMemoryExtensionController | undefined> {
  return runAgentOSPiProgram(
    registerMateMemoryExtensionLiveEffect(pi, dependencies),
  );
}

export default registerMateMemoryExtension;

function restoredPauseState(context: ExtensionContext): boolean {
  let paused = false;
  for (const entry of context.sessionManager.getBranch()) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "type" in entry &&
      entry.type === "custom" &&
      "customType" in entry &&
      entry.customType === STATE_ENTRY &&
      "data" in entry &&
      typeof entry.data === "object" &&
      entry.data !== null &&
      "paused" in entry.data &&
      typeof entry.data.paused === "boolean"
    ) paused = entry.data.paused;
  }
  return paused;
}

function nativeToolPath(
  event: ToolCallEvent,
  context: ExtensionContext,
  paths: Path.Path,
): string | undefined {
  if (!("path" in event.input) || typeof event.input.path !== "string") {
    return undefined;
  }
  return paths.resolve(context.cwd, event.input.path);
}

function isWithin(root: string, target: string, paths: Path.Path): boolean {
  const fromRoot = paths.relative(root, target);
  return fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${paths.sep}`) &&
      !fromRoot.startsWith(paths.sep));
}

function memoryRelativePath(
  root: string,
  target: string,
  paths: Path.Path,
) {
  const fromRoot = paths.relative(root, target).split(paths.sep).join("/");
  return fromRoot
    ? Result.succeed(fromRoot)
    : Result.fail(
      extensionError("path_invalid", "memory root itself is not a file"),
    );
}

function canonicalTopicPath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized.startsWith("topics/") ||
    normalized.includes("/../") ||
    normalized.includes("/./") ||
    normalized.endsWith("/") ||
    !normalized.endsWith(".md")
  ) {
    return Effect.fail(
      extensionError(
        "path_invalid",
        "memory delete path must be a relative topics/*.md path",
      ),
    );
  }
  const invalid = normalized.split("/").some((segment) =>
    !segment ||
    segment === "." ||
    segment === ".." ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(segment)
  );
  return invalid
    ? Effect.fail(
      extensionError(
        "path_invalid",
        "memory delete path must use lowercase safe topic segments",
      ),
    )
    : Effect.succeed(normalized);
}

function pausedMemoryToolResult() {
  return {
    block: true,
    reason: "Mate memory is paused for this Pi session.",
  };
}

function formattedTopicBytes(topic: StoredTopic): number {
  return Buffer.byteLength(relevantMemoryMessage([topic]));
}

function failedToolResult(event: ToolResultEvent, error: unknown) {
  const failure: { readonly type: "text"; readonly text: string } = {
    type: "text",
    text: `Mate memory validation failed: ${errorMessage(error)}`,
  };
  return {
    content: [
      ...event.content,
      failure,
    ],
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function platformTag(error: unknown): string | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("reason" in error) ||
    typeof error.reason !== "object" ||
    error.reason === null ||
    !("_tag" in error.reason) ||
    typeof error.reason._tag !== "string"
  ) return undefined;
  return error.reason._tag;
}
