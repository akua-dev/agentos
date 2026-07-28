import { relative, resolve, sep } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import {
  createMateMemoryStore,
  type MateMemoryStore,
  type StartupMemoryContext,
  type StoredTopic,
} from "../../../runtime/memory/store.ts";
import type { MateMemoryPolicy } from "../../../runtime/memory/policy.ts";
import { createMemoryActivityStore } from "../../../runtime/memory/activity.ts";
import {
  relevantMemoryMessage,
  startupSystemPrompt,
} from "./prompts.ts";
import {
  selectRelevantTopics,
  type RelevantTopicSelector,
} from "./model.ts";
import {
  MateMemoryMaintenance,
  type MaintenanceAgentRunner,
} from "./maintenance.ts";

const STATE_ENTRY = "agentos-mate-memory-state";
const CONTEXT_MESSAGE = "agentos-mate-memory-context";
const MEMORY_TOOL = "set_mate_memory_state";
const nativeFileTools = new Set(["read", "write", "edit"]);
const nativeWriteTools = new Set(["write", "edit"]);

export interface MateMemoryExtensionDependencies {
  home?: string;
  policy?: Partial<MateMemoryPolicy>;
  selectRelevant?: RelevantTopicSelector;
  now?: () => Date;
  onDirectMemoryWrite?: (relativePath: string) => void;
  store?: MateMemoryStore;
  maintenanceRunner?: MaintenanceAgentRunner;
}

export function registerMateMemoryExtension(
  pi: ExtensionAPI,
  dependencies: MateMemoryExtensionDependencies = {},
) {
  if (process.env.AGENTOS_DISABLE_MATE_MEMORY?.toLowerCase() === "true") {
    return;
  }
  const home = dependencies.home ?? process.env.HOME;
  if (!home) throw new Error("HOME must point at the mounted Mate home");
  const store =
    dependencies.store ?? createMateMemoryStore(home, dependencies.policy);
  const selector = dependencies.selectRelevant ?? selectRelevantTopics;
  const now = dependencies.now ?? (() => new Date());
  const activity = createMemoryActivityStore(home, { now });
  const attached = new Set<string>();
  const pendingWrites = new Map<string, string>();
  const observedToolNames = new Set<string>();
  let attachedBytes = 0;
  let paused = false;
  const maintenance = new MateMemoryMaintenance({
    store,
    runner: dependencies.maintenanceRunner,
    isPaused: () => paused,
    now,
    onEvent: (event) =>
      pi.appendEntry("agentos-mate-memory-maintenance", event),
  });

  pi.on("session_start", async (_event, context) => {
    attached.clear();
    attachedBytes = 0;
    pendingWrites.clear();
    observedToolNames.clear();
    paused = restoredPauseState(context);
    try {
      await activity.ensureState(now());
    } catch (error) {
      recordFailure(`activity state is unavailable: ${errorMessage(error)}`);
    }
  });

  pi.on("input", async (event, context) => {
    maintenance.captureHumanInput(event.text, event.source);
    if (event.source !== "extension") {
      try {
        await activity.append(context.sessionManager.getSessionId(), {
          kind: "human",
          text: event.text,
        });
      } catch (error) {
        recordFailure(`activity projection failed: ${errorMessage(error)}`);
      }
    }
  });

  pi.on("agent_settled", (_event, context) => {
    const maintenanceContext = {
      agentDir: joinAgentDirectory(home),
      cwd: context.cwd,
      model: context.model,
      signal: context.signal,
    };
    maintenance.afterAgentSettled(maintenanceContext);
    void maintenance.maybeDream(
      maintenanceContext,
      activity,
      context.sessionManager.getSessionId(),
    );
  });

  pi.on("agent_end", async (event, context) => {
    const sessionId = context.sessionManager.getSessionId();
    try {
      for (const toolName of [...observedToolNames].sort()) {
        await activity.append(sessionId, { kind: "tool", toolName });
      }
      const assistant = [...event.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (!assistant || assistant.role !== "assistant") return;
      const text = assistant.content
        .filter(
          (part): part is Extract<typeof part, { type: "text" }> =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("")
        .trim();
      if (text) await activity.append(sessionId, { kind: "assistant", text });
    } catch (error) {
      recordFailure(`activity projection failed: ${errorMessage(error)}`);
    } finally {
      observedToolNames.clear();
    }
  });

  pi.on("session_shutdown", async (_event, context) => {
    try {
      await activity.completeSession(
        context.sessionManager.getSessionId(),
        now(),
      );
    } catch (error) {
      recordFailure(`session activity completion failed: ${errorMessage(error)}`);
    }
    await maintenance.shutdown(60_000);
  });

  pi.on("before_agent_start", async (event, context) => {
    if (paused || !store.policy.enabled) {
      return { systemPrompt: event.systemPrompt };
    }
    let startup: StartupMemoryContext;
    try {
      startup = await store.readStartupContext();
    } catch (error) {
      startup = {
        index: "",
        pinned: [],
        inventory: [],
        degraded: [
          `Mate memory is unavailable: ${errorMessage(error)}`,
        ],
      };
    }
    const boundedPinned: StoredTopic[] = [];
    let pinnedBytes = 0;
    for (const topic of startup.pinned) {
      const bytes = formattedTopicBytes(topic);
      if (
        pinnedBytes + bytes >
        store.policy.maxSessionAttachmentBytes
      ) {
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
    let selected: StoredTopic[] = [];
    try {
      const paths = await selector({
        prompt: event.prompt,
        startup,
        model: context.model,
        modelRegistry: context.modelRegistry,
        signal: context.signal,
      });
      const allowed = new Set(
        startup.inventory
          .filter(({ pinned }) => !pinned)
          .map(({ relativePath }) => relativePath),
      );
      for (const path of paths) {
        if (
          selected.length >= store.policy.maxRelevantTopics ||
          !allowed.has(path) ||
          attached.has(path)
        ) {
          continue;
        }
        const topic = await store.readTopic(path);
        const candidate = relevantMemoryMessage([...selected, topic]);
        if (
          attachedBytes + Buffer.byteLength(candidate) >
          store.policy.maxSessionAttachmentBytes
        ) {
          continue;
        }
        selected.push(topic);
      }
    } catch (error) {
      startup.degraded.push(
        `relevant-memory selection failed: ${errorMessage(error)}`,
      );
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
  });

  pi.on("tool_call", async (event, context) => {
    observedToolNames.add(event.toolName);
    if (!nativeFileTools.has(event.toolName)) return;
    const target = nativeToolPath(event, context);
    if (!target || !isWithin(store.root, target)) return;
    if (paused && nativeWriteTools.has(event.toolName)) {
      return {
        block: true,
        reason: "Mate memory is paused for this Pi session.",
      };
    }
    let relativePath: string;
    try {
      relativePath = memoryRelativePath(store.root, target);
      await store.resolveMemoryPath(relativePath);
    } catch (error) {
      return {
        block: true,
        reason: `Unsafe Mate memory path: ${errorMessage(error)}`,
      };
    }
    if (nativeWriteTools.has(event.toolName)) {
      pendingWrites.set(event.toolCallId, relativePath);
    }
  });

  pi.on("tool_result", async (event) => {
    const relativePath = pendingWrites.get(event.toolCallId);
    if (!relativePath) return;
    pendingWrites.delete(event.toolCallId);
    if (event.isError) return;
    try {
      if (relativePath === "MEMORY.md") {
        const startup = await store.readStartupContext();
        const indexWarnings = startup.degraded.filter((warning) =>
          warning.startsWith("MEMORY.md"),
        );
        if (indexWarnings.length > 0) {
          throw new Error(indexWarnings.join("; "));
        }
      } else {
        await store.validateAndStamp(relativePath, { now: now() });
      }
      dependencies.onDirectMemoryWrite?.(relativePath);
      maintenance.noteDirectMemoryWrite();
    } catch (error) {
      return failedToolResult(event, error);
    }
  });

  pi.registerCommand("memory", {
    description: "Pause, resume, or inspect Mate memory for this Pi session",
    handler: async (args, context) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "pause") setPaused(true);
      else if (action === "resume") setPaused(false);
      else if (action !== "status") {
        context.ui.notify("Usage: /memory pause|resume|status", "error");
        return;
      }
      context.ui.notify(
        paused
          ? "Mate memory is paused for this Pi session."
          : "Mate memory is active for this Pi session.",
        "info",
      );
    },
  });

  pi.registerTool({
    name: MEMORY_TOOL,
    label: "Set Mate memory state",
    description:
      "Pause, resume, or inspect private Mate memory for only the current Pi session.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("status"),
      ]),
    }),
    async execute(_toolCallId, { action }) {
      if (action === "pause") setPaused(true);
      else if (action === "resume") setPaused(false);
      return {
        content: [
          {
            type: "text",
            text: paused
              ? "Mate memory is paused for this Pi session."
              : "Mate memory is active for this Pi session.",
          },
        ],
        details: { paused },
      };
    },
  });

  return {
    isPaused: () => paused,
    store,
    maintenance,
    activity,
  };

  function setPaused(value: boolean) {
    paused = value;
    pi.appendEntry(STATE_ENTRY, { paused });
  }

  function recordFailure(summary: string) {
    pi.appendEntry("agentos-mate-memory-maintenance", {
      status: "failed",
      summary,
    });
  }
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
    ) {
      paused = entry.data.paused;
    }
  }
  return paused;
}

function nativeToolPath(
  event: ToolCallEvent,
  context: ExtensionContext,
): string | undefined {
  if (!("path" in event.input) || typeof event.input.path !== "string") {
    return undefined;
  }
  return resolve(context.cwd, event.input.path);
}

function isWithin(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !fromRoot.startsWith(sep))
  );
}

function memoryRelativePath(root: string, target: string): string {
  const fromRoot = relative(root, target).split(sep).join("/");
  if (!fromRoot) throw new Error("memory root itself is not a file");
  return fromRoot;
}

function formattedTopicBytes(topic: StoredTopic): number {
  return Buffer.byteLength(relevantMemoryMessage([topic]));
}

function failedToolResult(event: ToolResultEvent, error: unknown) {
  return {
    content: [
      ...event.content,
      {
        type: "text" as const,
        text: `Mate memory validation failed: ${errorMessage(error)}`,
      },
    ],
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function joinAgentDirectory(home: string): string {
  return resolve(home, ".pi", "agent");
}
