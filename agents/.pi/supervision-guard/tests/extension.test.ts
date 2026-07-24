import { describe, expect, test } from "bun:test";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { registerAgentosSupervisionGuard } from "../extension.ts";

type EventHandler = (event: any, context: ExtensionContext) => unknown;

class FakePi {
  readonly handlers = new Map<string, EventHandler[]>();
  readonly messages: Array<{ message: any; options: unknown }> = [];

  on(event: string, handler: EventHandler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  sendMessage(message: any, options: unknown) {
    this.messages.push({ message, options });
  }

  extensionApi() {
    return this as unknown as ExtensionAPI;
  }

  async emit(event: string, payload: Record<string, unknown> = {}) {
    const context = {
      isIdle: () => true,
      sessionManager: { getEntries: () => [] },
      ui: { notify: () => undefined },
    } as unknown as ExtensionContext;
    for (const handler of this.handlers.get(event) ?? []) {
      await handler({ type: event, ...payload }, context);
    }
  }
}

describe("AgentOS Mate supervision guard", () => {
  test("starts one recovery turn at session startup", async () => {
    const pi = new FakePi();
    registerAgentosSupervisionGuard(pi.extensionApi());

    await pi.emit("session_start");
    await pi.emit("session_start");

    expect(pi.messages).toHaveLength(1);
    expect(pi.messages[0]).toMatchObject({
      message: {
        customType: "agentos-supervision-recovery",
        display: true,
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    });
    expect(pi.messages[0]!.message.content).toContain(
      'list_background_commands with state "interrupted"',
    );
  });

  test("can be disabled for the whole Pi runtime through environment", async () => {
    const previous = process.env.AGENTOS_DISABLE_SUPERVISION_GUARD;
    process.env.AGENTOS_DISABLE_SUPERVISION_GUARD = "true";
    try {
      const pi = new FakePi();
      registerAgentosSupervisionGuard(pi.extensionApi());

      await pi.emit("session_start");
      await pi.emit("agent_settled");

      expect(pi.messages).toEqual([]);
      expect(pi.handlers.size).toBe(0);
    } finally {
      restoreEnvironment("AGENTOS_DISABLE_SUPERVISION_GUARD", previous);
    }
  });

  test("reminds once without a known tagged continuity wait", async () => {
    const pi = new FakePi();
    registerAgentosSupervisionGuard(pi.extensionApi());

    await pi.emit("agent_settled");
    await pi.emit("agent_settled");

    expect(pi.messages).toHaveLength(1);
    expect(pi.messages[0]).toMatchObject({
      message: {
        customType: "agentos-supervision-guard",
        display: true,
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    });
  });

  test("remembers a tagged command start across later turns without listing", async () => {
    const pi = new FakePi();
    registerAgentosSupervisionGuard(pi.extensionApi());
    await pi.emit("tool_result", {
      toolName: "run_background_command",
      isError: false,
      details: {
        id: "bg-watch",
        state: "running",
        description:
          "[agentos-supervision] Wait for the next Fleet coordination event",
      },
    });

    await pi.emit("agent_settled");
    await pi.emit("agent_settled");

    expect(pi.messages).toEqual([]);
  });

  test("forgets a tagged command when its completion wake arrives", async () => {
    const pi = new FakePi();
    registerAgentosSupervisionGuard(pi.extensionApi());
    await pi.emit("tool_result", {
      toolName: "run_background_command",
      isError: false,
      details: {
        id: "bg-watch",
        state: "running",
        description:
          "[agentos-supervision] Wait for the next Fleet coordination event",
      },
    });
    await pi.emit("message_start", {
      message: {
        role: "custom",
        customType: "agentos-background-command-completion",
        details: { taskIds: ["bg-watch"] },
      },
    });

    await pi.emit("agent_settled");

    expect(pi.messages).toHaveLength(1);
  });

  test("does not accept an inspected list without a running command", async () => {
    const pi = new FakePi();
    registerAgentosSupervisionGuard(pi.extensionApi());
    await pi.emit("tool_result", {
      toolName: "list_background_commands",
      isError: false,
      details: {
        tasks: [
          { id: "bg-done", state: "succeeded" },
          { id: "bg-failed", state: "failed" },
        ],
      },
    });

    await pi.emit("agent_settled");

    expect(pi.messages).toHaveLength(1);
  });

  test("does not accept an untagged running command", async () => {
    const pi = new FakePi();
    registerAgentosSupervisionGuard(pi.extensionApi());
    await pi.emit("tool_result", {
      toolName: "list_background_commands",
      isError: false,
      details: {
        tasks: [
          {
            id: "bg-unrelated",
            state: "running",
            description: "Watch an unrelated build",
            command: "anything-the-mate-selected --with its-own-rules",
          },
        ],
      },
    });

    await pi.emit("agent_settled");

    expect(pi.messages).toHaveLength(1);
  });

  test("accepts a running command whose useful description contains the tag", async () => {
    const pi = new FakePi();
    registerAgentosSupervisionGuard(pi.extensionApi());
    await pi.emit("tool_result", {
      toolName: "list_background_commands",
      isError: false,
      details: {
        tasks: [
          {
            id: "bg-watch",
            state: "running",
            description:
              "[agentos-supervision] Wait for the next Fleet coordination event",
            command: "anything-the-mate-selected --with its-own-rules",
          },
        ],
      },
    });

    await pi.emit("agent_settled");

    expect(pi.messages).toEqual([]);
  });

  test("does not erase a known running wait after listing interrupted history", async () => {
    const pi = new FakePi();
    registerAgentosSupervisionGuard(pi.extensionApi());
    await pi.emit("tool_result", {
      toolName: "run_background_command",
      input: {
        description:
          "[agentos-supervision] Wait for the next Fleet coordination event",
      },
      isError: false,
      details: {
        id: "bg-watch",
        state: "running",
        description:
          "[agentos-supervision] Wait for the next Fleet coordination event",
      },
    });
    await pi.emit("tool_result", {
      toolName: "list_background_commands",
      input: { state: "interrupted" },
      isError: false,
      details: {
        tasks: [
          {
            id: "bg-old",
            state: "interrupted",
            description:
              "[agentos-supervision] An older interrupted continuity wait",
          },
        ],
      },
    });

    await pi.emit("agent_settled");

    expect(pi.messages).toEqual([]);
  });
});

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
