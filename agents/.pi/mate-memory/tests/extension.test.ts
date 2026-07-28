import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
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

import { createMateMemoryStore } from "../../../../runtime/memory/store.ts";
import { registerMateMemoryExtension } from "../extension.ts";

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
    expect(selections).toHaveLength(2);
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

  test("pauses loading and memory writes for the current session and restores that state", async () => {
    const { home } = await fixture();
    const pi = new FakePi();
    registerMateMemoryExtension(pi.extensionApi(), {
      home,
      selectRelevant: async () => ["topics/agentos.md"],
    });
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
});
