import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  createMateMemoryStore,
  type MateMemoryStore,
} from "../../../../runtime/memory/store.ts";
import {
  createMemoryActivityStore,
  type MemoryActivityStore,
} from "../../../../runtime/memory/activity.ts";
import { registerMateMemoryExtension } from "../extension.ts";
import type { MaintenanceRunRequest } from "../maintenance.ts";

type EventHandler = (event: any, context: ExtensionContext) => unknown;

class FakePi {
  readonly handlers = new Map<string, EventHandler[]>();
  readonly commands = new Map<
    string,
    Omit<RegisteredCommand, "name" | "sourceInfo">
  >();
  readonly tools = new Map<string, ToolDefinition>();
  readonly entries: Array<{ customType: string; data: unknown }> = [];

  on(event: string, handler: EventHandler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  registerCommand(
    name: string,
    command: Omit<RegisteredCommand, "name" | "sourceInfo">,
  ) {
    this.commands.set(name, command);
  }

  registerTool(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
  }

  appendEntry(customType: string, data: unknown) {
    this.entries.push({ customType, data });
  }

  extensionApi() {
    return this as unknown as ExtensionAPI;
  }

  async emit(
    event: string,
    payload: Record<string, unknown> = {},
    context: Partial<ExtensionContext> = {},
  ) {
    const notifications: string[] = [];
    const extensionContext = {
      cwd: "/workspace",
      isIdle: () => true,
      model: undefined,
      sessionManager: { getBranch: () => [] },
      ui: {
        notify: (message: string) => notifications.push(message),
      },
      ...context,
    } as unknown as ExtensionContext;
    const results: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) {
      results.push(
        await handler({ type: event, ...payload }, extensionContext),
      );
    }
    return { notifications, results };
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "agentos-pi-memory-"));
  temporaryDirectories.push(home);
  const store = createMateMemoryStore(home);
  await store.ensureLayout();
  await store.writeIndex(
    "# Memory index\n- reporting: Captain prefers outcome-first updates\n",
  );
  const metadata = {
    node_type: "memory" as const,
    type: "feedback" as const,
    scope: "captain",
    source_principal: "captain",
    observed_at: "2026-07-28T08:00:00.000Z",
    modified: "2026-07-28T08:00:00.000Z",
    pinned: false,
  };
  await store.writeTopic({
    relativePath: "topics/reporting.md",
    metadata,
    body: "Lead with the outcome.",
  });
  await store.writeTopic({
    relativePath: "topics/agentos.md",
    metadata: { ...metadata, type: "project" },
    body: "AgentOS uses PostgreSQL as durable Fleet truth.",
  });
  await store.writeTopic({
    relativePath: "topics/pinned.md",
    metadata: { ...metadata, pinned: true },
    body: "Never merge without exact authority.",
  });
  return { home, store };
}

describe("Pi Mate memory extension", () => {
  test("loads the bounded index and pinned topics, then attaches selected topics once", async () => {
    const { home } = await fixture();
    const pi = new FakePi();
    const selections: string[][] = [];
    registerMateMemoryExtension(pi.extensionApi(), {
      home,
      selectRelevant: async () => {
        const result = [
          "topics/agentos.md",
          "../escape.md",
          "topics/pinned.md",
        ];
        selections.push(result);
        return result;
      },
    });

    const first = await pi.emit("before_agent_start", {
      prompt: "How should we change AgentOS?",
      systemPrompt: "ROLE",
      systemPromptOptions: {},
    });
    const firstResult = first.results[0] as {
      systemPrompt: string;
      message: { content: string; customType: string; display: boolean };
    };
    expect(firstResult.systemPrompt).toContain(
      "Captain prefers outcome-first updates",
    );
    expect(firstResult.systemPrompt.includes("Never merge without exact authority.")).toBe(
      true,
    );
    expect(firstResult.message.customType).toBe(
      "agentos-mate-memory-context",
    );
    expect(firstResult.message.display).toBe(false);
    expect(firstResult.message.content).toContain(
      "AgentOS uses PostgreSQL as durable Fleet truth.",
    );
    expect(
      firstResult.message.content,
    ).not.toContain("pinned.md");

    const second = await pi.emit("before_agent_start", {
      prompt: "Continue",
      systemPrompt: "ROLE",
      systemPromptOptions: {},
    });
    expect(second.results[0]).not.toHaveProperty("message");

    await pi.emit("session_start");
    const nextSession = await pi.emit("before_agent_start", {
      prompt: "Start a new Pi session",
      systemPrompt: "ROLE",
      systemPromptOptions: {},
    });
    expect(nextSession.results[0]).toHaveProperty("message");
    expect(selections).toHaveLength(3);
  });

  test("caps selected paths and total attachment bytes", async () => {
    const { home, store } = await fixture();
    for (let index = 0; index < 7; index += 1) {
      await store.writeTopic({
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
    const pi = new FakePi();
    registerMateMemoryExtension(pi.extensionApi(), {
      home,
      policy: {
        maxRelevantTopics: 5,
        maxSessionAttachmentBytes: 900,
      },
      selectRelevant: async () =>
        Array.from({ length: 7 }, (_, index) => `topics/item-${index}.md`),
    });

    const result = await pi.emit("before_agent_start", {
      prompt: "Recall references",
      systemPrompt: "ROLE",
      systemPromptOptions: {},
    });
    const content = (
      result.results[0] as { message: { content: string } }
    ).message.content;
    expect((content.match(/^## topics\//gm) ?? []).length).toBeLessThanOrEqual(
      5,
    );
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(900);
  });

  test("does not let oversized pinned topics bypass the session attachment budget", async () => {
    const { home, store } = await fixture();
    const pinned = await store.readTopic("topics/pinned.md");
    await store.writeTopic({
      relativePath: pinned.relativePath,
      metadata: pinned.metadata,
      body: "p".repeat(2_000),
    });
    const pi = new FakePi();
    registerMateMemoryExtension(pi.extensionApi(), {
      home,
      policy: { maxSessionAttachmentBytes: 700 },
      selectRelevant: async () => ["topics/agentos.md"],
    });

    const result = await pi.emit("before_agent_start", {
      prompt: "Recall AgentOS",
      systemPrompt: "ROLE",
      systemPromptOptions: {},
    });
    const loaded = result.results[0] as {
      systemPrompt: string;
      message?: { content: string };
    };
    expect(loaded.systemPrompt).not.toContain("p".repeat(100));
    expect(loaded.systemPrompt).toContain(
      "pinned topic topics/pinned.md exceeds the remaining attachment budget",
    );
    expect(loaded.message?.content).toContain(
      "AgentOS uses PostgreSQL as durable Fleet truth.",
    );
  });

  test("pauses loading and memory writes for the current session and restores that state", async () => {
    const { home } = await fixture();
    const pi = new FakePi();
    const controller = registerMateMemoryExtension(pi.extensionApi(), {
      home,
      now: () => new Date("2026-07-28T08:00:00.000Z"),
      selectRelevant: async () => ["topics/agentos.md"],
    });
    const sessionManager = {
      getBranch: () => [],
      getSessionId: () => "paused-activity",
    } as never;
    await pi.emit(
      "tool_call",
      { toolCallId: "before-pause", toolName: "read", input: {} },
      { sessionManager },
    );
    const notices: string[] = [];
    await pi.commands.get("memory")!.handler("pause", {
      ui: { notify: (message: string) => notices.push(message) },
    } as unknown as ExtensionCommandContext);
    expect(notices).toEqual(["Mate memory is paused for this Pi session."]);
    expect(pi.entries.at(-1)).toEqual({
      customType: "agentos-mate-memory-state",
      data: { paused: true },
    });

    const paused = await pi.emit("before_agent_start", {
      prompt: "Use memory",
      systemPrompt: "ROLE",
      systemPromptOptions: {},
    });
    expect(paused.results[0]).toEqual({ systemPrompt: "ROLE" });

    const blocked = await pi.emit("tool_call", {
      toolCallId: "write-1",
      toolName: "write",
      input: { path: join(home, "memory", "MEMORY.md"), content: "replace" },
    });
    expect(blocked.results[0]).toEqual({
      block: true,
      reason: "Mate memory is paused for this Pi session.",
    });
    const blockedRead = await pi.emit("tool_call", {
      toolCallId: "read-1",
      toolName: "read",
      input: { path: join(home, "memory", "MEMORY.md") },
    });
    expect(blockedRead.results[0]).toEqual({
      block: true,
      reason: "Mate memory is paused for this Pi session.",
    });

    await pi.emit(
      "input",
      { text: "Human input while paused", source: "interactive" },
      { sessionManager },
    );
    await pi.emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Assistant output while paused" }],
          },
        ],
      },
      { sessionManager },
    );
    expect(await controller!.activity.readRecent(3)).toBe("");

    await pi.commands.get("memory")!.handler("resume", {
      ui: { notify: () => undefined },
    } as unknown as ExtensionCommandContext);
    await pi.emit(
      "input",
      { text: "Human input after resume", source: "interactive" },
      { sessionManager },
    );
    await pi.emit(
      "tool_call",
      { toolCallId: "after-resume", toolName: "grep", input: {} },
      { sessionManager },
    );
    await pi.emit(
      "agent_end",
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Assistant output after resume" }],
          },
        ],
      },
      { sessionManager },
    );
    const resumed = await controller!.activity.readRecent(3);
    expect(resumed).toContain("Human input after resume");
    expect(resumed).toContain(". grep");
    expect(resumed).toContain("Assistant output after resume");
    expect(resumed).not.toContain("Human input while paused");
    expect(resumed).not.toContain("Assistant output while paused");
    expect(resumed).not.toContain(". read");

    const restoredPi = new FakePi();
    registerMateMemoryExtension(restoredPi.extensionApi(), { home });
    await restoredPi.emit(
      "session_start",
      {},
      {
        sessionManager: {
          getBranch: () => [
            {
              type: "custom",
              customType: "agentos-mate-memory-state",
              data: { paused: true },
            },
          ],
        } as never,
      },
    );
    const restored = await restoredPi.emit("before_agent_start", {
      prompt: "Use memory",
      systemPrompt: "ROLE",
      systemPromptOptions: {},
    });
    expect(restored.results[0]).toEqual({ systemPrompt: "ROLE" });
  });

  test("does not return recall that crosses a pause transition", async () => {
    const { home } = await fixture();
    const pi = new FakePi();
    let releaseSelection!: () => void;
    let selectionStarted!: () => void;
    const selectionReleased = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    const selectionStartedPromise = new Promise<void>((resolve) => {
      selectionStarted = resolve;
    });
    registerMateMemoryExtension(pi.extensionApi(), {
      home,
      selectRelevant: async () => {
        selectionStarted();
        await selectionReleased;
        return ["topics/agentos.md"];
      },
    });

    const recall = pi.emit("before_agent_start", {
      prompt: "Recall memory",
      systemPrompt: "ROLE",
      systemPromptOptions: {},
    });
    await selectionStartedPromise;
    await pi.commands.get("memory")!.handler("pause", {
      ui: { notify: () => undefined },
    } as unknown as ExtensionCommandContext);
    releaseSelection();

    expect((await recall).results[0]).toEqual({ systemPrompt: "ROLE" });
  });

  test("does not commit activity that pauses while appending", async () => {
    const { home } = await fixture();
    const realActivity = createMemoryActivityStore(home, {
      now: () => new Date("2026-07-28T08:00:00.000Z"),
    });
    let releaseAppend!: () => void;
    let appendStarted!: () => void;
    const appendReleased = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const appendStartedPromise = new Promise<void>((resolve) => {
      appendStarted = resolve;
    });
    const delayedActivity: MemoryActivityStore = {
      ...realActivity,
      async append(sessionId, projection, options) {
        appendStarted();
        await appendReleased;
        await options?.beforeCommit?.();
        await realActivity.append(sessionId, projection);
      },
    };
    const pi = new FakePi();
    const controller = registerMateMemoryExtension(pi.extensionApi(), {
      home,
      activity: delayedActivity,
    });
    const sessionManager = {
      getBranch: () => [],
      getSessionId: () => "pause-race",
    } as never;

    const input = pi.emit(
      "input",
      { text: "This must not survive pause", source: "interactive" },
      { sessionManager },
    );
    await appendStartedPromise;
    await pi.commands.get("memory")!.handler("pause", {
      ui: { notify: () => undefined },
    } as unknown as ExtensionCommandContext);
    releaseAppend();
    await input;

    expect(await controller!.activity.readRecent(3)).toBe("");
  });

  test("reserves native topic capacity across pending writes", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentos-pi-memory-limit-"));
    temporaryDirectories.push(home);
    const store = createMateMemoryStore(home, { maxTopicFiles: 2 });
    await store.ensureLayout();
    await store.writeTopic({
      relativePath: "topics/existing.md",
      metadata: {
        node_type: "memory",
        type: "reference",
        scope: "fleet",
        source_principal: "captain",
        observed_at: "2026-07-28T08:00:00.000Z",
        modified: "2026-07-28T08:00:00.000Z",
        pinned: false,
      },
      body: "Existing topic.",
    });
    const pi = new FakePi();
    registerMateMemoryExtension(pi.extensionApi(), { home, store });
    const first = await pi.emit("tool_call", {
      toolCallId: "new-a",
      toolName: "write",
      input: { path: join(home, "memory", "topics", "new-a.md") },
    });
    expect(first.results[0]).toBeUndefined();
    const second = await pi.emit("tool_call", {
      toolCallId: "new-b",
      toolName: "write",
      input: { path: join(home, "memory", "topics", "new-b.md") },
    });
    expect(second.results[0]).toEqual({
      block: true,
      reason: "Mate memory has reached its 2-topic limit.",
    });
    await pi.emit("tool_result", {
      toolCallId: "new-a",
      toolName: "write",
      input: {},
      content: [],
      details: {},
      isError: true,
    });
    const third = await pi.emit("tool_call", {
      toolCallId: "new-c",
      toolName: "write",
      input: { path: join(home, "memory", "topics", "new-c.md") },
    });
    expect(third.results[0]).toBeUndefined();
  });

  test("blocks a native topic write when pause races its capacity check", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentos-pi-memory-pause-limit-"));
    temporaryDirectories.push(home);
    const store = createMateMemoryStore(home, { maxTopicFiles: 2 });
    await store.ensureLayout();
    await store.writeTopic({
      relativePath: "topics/existing.md",
      metadata: {
        node_type: "memory",
        type: "project",
        scope: "fleet",
        source_principal: "captain",
        observed_at: "2026-07-28T08:00:00.000Z",
        modified: "2026-07-28T08:00:00.000Z",
        pinned: false,
      },
      body: "Existing topic.",
    });
    let releaseList!: () => void;
    let listStarted!: () => void;
    const listReleased = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const listStartedPromise = new Promise<void>((resolve) => {
      listStarted = resolve;
    });
    const delayedStore: MateMemoryStore = {
      ...store,
      async listTopics() {
        listStarted();
        await listReleased;
        return store.listTopics();
      },
    };
    const pi = new FakePi();
    registerMateMemoryExtension(pi.extensionApi(), {
      home,
      store: delayedStore,
    });

    const call = pi.emit("tool_call", {
      toolCallId: "pause-race-write",
      toolName: "write",
      input: { path: join(home, "memory", "topics", "new.md") },
    });
    await listStartedPromise;
    await pi.commands.get("memory")!.handler("pause", {
      ui: { notify: () => undefined },
    } as unknown as ExtensionCommandContext);
    releaseList();

    expect((await call).results[0]).toEqual({
      block: true,
      reason: "Mate memory is paused for this Pi session.",
    });
  });

  test("validates and stamps successful native topic edits", async () => {
    const { home } = await fixture();
    const pi = new FakePi();
    let directWrites = 0;
    registerMateMemoryExtension(pi.extensionApi(), {
      home,
      now: () => new Date("2026-07-28T10:00:00.000Z"),
      onDirectMemoryWrite: () => {
        directWrites += 1;
      },
    });
    const path = join(home, "memory", "topics", "reporting.md");
    const call = await pi.emit("tool_call", {
      toolCallId: "edit-1",
      toolName: "edit",
      input: { path, oldText: "outcome", newText: "result" },
    });
    expect(call.results[0]).toBeUndefined();
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("outcome", "result"),
      "utf8",
    );
    const result = await pi.emit("tool_result", {
      toolCallId: "edit-1",
      toolName: "edit",
      input: { path },
      content: [{ type: "text", text: "edited" }],
      details: {},
      isError: false,
    });
    expect(result.results[0]).toBeUndefined();
    expect(await readFile(path, "utf8")).toContain(
      "modified: 2026-07-28T10:00:00.000Z",
    );
    expect(directWrites).toBe(1);
  });

  test("exposes guarded direct topic forgetting without editing MEMORY.md", async () => {
    const { home, store } = await fixture();
    const pi = new FakePi();
    const controller = registerMateMemoryExtension(pi.extensionApi(), { home });
    const forget = pi.tools.get("memory_delete_topic")!;

    expect(forget).toBeDefined();
    await forget.execute(
      "forget-1",
      { path: "topics/reporting.md" } as never,
      undefined,
      undefined,
      {} as never,
    );

    await expect(store.readTopic("topics/reporting.md")).rejects.toThrow();
    expect(await readFile(join(home, "memory", "MEMORY.md"), "utf8")).toContain(
      "reporting",
    );
    expect(controller!.isPaused()).toBe(false);
  });

  test("passes the pause-generation read guard into startup recall", async () => {
    const { home, store } = await fixture();
    const pi = new FakePi();
    let reads = 0;
    const guardedStore: MateMemoryStore = {
      ...store,
      async readStartupContext(options) {
        return store.readStartupContext({
          beforeRead: async () => {
            reads += 1;
            if (reads === 2) {
              await pi.commands.get("memory")!.handler("pause", {
                ui: { notify: () => undefined },
              } as unknown as ExtensionCommandContext);
            }
            await options?.beforeRead?.();
          },
        });
      },
    };
    registerMateMemoryExtension(pi.extensionApi(), { home, store: guardedStore });

    const result = await pi.emit("before_agent_start", {
      prompt: "Recall memory",
      systemPrompt: "ROLE",
      systemPromptOptions: {},
    });

    expect(result.results[0]).toEqual({ systemPrompt: "ROLE" });
    expect(reads).toBe(2);
  });

  test("connects only direct human input to restricted post-turn extraction", async () => {
    const { home } = await fixture();
    const pi = new FakePi();
    const requests: MaintenanceRunRequest[] = [];
    const controller = registerMateMemoryExtension(pi.extensionApi(), {
      home,
      maintenanceRunner: async (request) => {
        requests.push(request);
        return { summary: "nothing to save", touchedPaths: [] };
      },
    })!;
    const sessionManager = {
      getBranch: () => [],
      getSessionId: () => "session-direct-human",
    } as never;

    await pi.emit(
      "input",
      {
        text: "Remember concise result summaries",
        source: "interactive",
      },
      { sessionManager },
    );
    await pi.emit(
      "input",
      {
        text: "Internal extension maintenance message",
        source: "extension",
      },
      { sessionManager },
    );
    await pi.emit(
      "agent_settled",
      {},
      {
        cwd: "/workspace",
        model: { provider: "test", id: "model" } as never,
        sessionManager,
      },
    );
    await controller.maintenance.drain(1_000);
    await controller.maintenance.shutdown(1_000);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toContain(
      "Remember concise result summaries",
    );
    expect(requests[0]!.prompt).not.toContain("Internal extension");
  });

  test("keeps the main Mate session available when the memory root is unsafe", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentos-pi-memory-unsafe-"));
    temporaryDirectories.push(home);
    const outside = join(home, "outside");
    await mkdir(outside);
    await symlink(outside, join(home, "memory"));
    const pi = new FakePi();
    registerMateMemoryExtension(pi.extensionApi(), { home });
    const sessionManager = {
      getBranch: () => [],
      getSessionId: () => "unsafe-root",
    } as never;

    await expect(
      pi.emit("session_start", {}, { sessionManager }),
    ).resolves.toBeDefined();
    const result = await pi.emit(
      "before_agent_start",
      {
        prompt: "Handle an urgent Inbox event",
        systemPrompt: "ROLE",
        systemPromptOptions: {},
      },
      { sessionManager },
    );
    expect(
      (result.results[0] as { systemPrompt: string }).systemPrompt,
    ).toContain("Mate memory is unavailable");
  });
});
