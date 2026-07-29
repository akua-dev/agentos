import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type Handler = (event: any, context: ExtensionContext) => unknown;

export function createFakePi(options: { idle?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const registrations: Array<{ kind: string; name?: string }> = [];
  const messages: Array<{
    message: Record<string, unknown>;
    options?: Record<string, unknown>;
  }> = [];
  const context = {
    isIdle: () => options.idle ?? true,
  } as ExtensionContext;
  const pi = {
    on(event: string, handler: Handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
      registrations.push({ kind: "handler", name: event });
    },
    registerCommand(name: string) {
      registrations.push({ kind: "command", name });
    },
    registerTool(tool: { name: string }) {
      registrations.push({ kind: "tool", name: tool.name });
    },
    sendMessage(
      message: Record<string, unknown>,
      messageOptions?: Record<string, unknown>,
    ) {
      messages.push({ message, options: messageOptions });
    },
  } as unknown as ExtensionAPI;

  return {
    context,
    handlers,
    messages,
    pi,
    registrations,
    async emit(event: string, value: Record<string, unknown>) {
      const results = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler(value, context));
      }
      return results;
    },
  };
}
