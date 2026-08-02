import {
  createExtensionRuntime,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";

import { loadExtensionFromFactory } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import { AgentOSValidationError } from "../src/shared/errors.ts";

export class PiTestHarnessError extends Schema.TaggedErrorClass<PiTestHarnessError>()(
  "PiTestHarnessError",
  {
    operation: Schema.Literals(["load", "emit", "execute"]),
    detail: Schema.String,
  },
) {}

export interface PiTestHarnessOptions {
  readonly context?: Readonly<Record<string, unknown>>;
  readonly cwd?: string;
  readonly idle?: boolean;
  readonly systemPrompt?: string;
}

function harnessError(
  operation: typeof PiTestHarnessError.fields.operation.Type,
  detail: string,
) {
  return PiTestHarnessError.make({ operation, detail });
}

function handlerError(event: string, cause: unknown) {
  const ownedDetail = cause instanceof AgentOSValidationError
    ? `: ${cause.message}`
    : "";
  return harnessError(
    "emit",
    `Pi handler for ${event} failed${ownedDetail}; unowned failure details are redacted`,
  );
}

const invokePiCallable = Effect.fn("test.pi.invokeCallable")(function*(
  operation: "emit" | "execute",
  label: string,
  callable: Function,
  args: ReadonlyArray<unknown>,
) {
  const outcome: unknown = yield* Effect.try({
    try: () => Reflect.apply(callable, undefined, Array.from(args)),
    catch: (cause) => operation === "emit"
      ? handlerError(label, cause)
      : harnessError("execute", `Pi tool ${label} failed; details are redacted`),
  });
  if (outcome instanceof Promise) {
    return yield* Effect.tryPromise({
      try: () => outcome,
      catch: (cause) => operation === "emit"
        ? handlerError(label, cause)
        : harnessError("execute", `Pi tool ${label} failed; details are redacted`),
    });
  }
  return outcome;
});

export const makePiTestHarness = Effect.fn("test.pi.makeHarness")(function*(
  options: PiTestHarnessOptions = {},
) {
  let capturedApi: ExtensionAPI | undefined;
  const runtime = createExtensionRuntime();
  const entries: Array<{ readonly customType: string; readonly data: unknown }> = [];
  const messages: Array<{
    readonly message: {
      readonly customType: string;
      readonly content: unknown;
      readonly display?: boolean;
      readonly details?: unknown;
    };
    readonly options: {
      readonly triggerTurn?: boolean;
      readonly deliverAs?: "steer" | "followUp" | "nextTurn";
    } | undefined;
  }> = [];
  runtime.sendMessage = (message, messageOptions) => {
    messages.push({ message, options: messageOptions });
  };
  runtime.appendEntry = (customType, data) => {
    entries.push({ customType, data });
  };
  const eventBus = {
    emit(_channel: string, _data: unknown) {},
    on(_channel: string, _handler: (data: unknown) => void) {
      return () => {};
    },
  };
  const extension = yield* Effect.tryPromise({
    try: () => loadExtensionFromFactory(
      (pi: ExtensionAPI) => {
        capturedApi = pi;
      },
      options.cwd ?? "/workspace",
      eventBus,
      runtime,
      "<agentos-test>",
    ),
    catch: () => harnessError("load", "Pi test extension could not be loaded"),
  });
  if (capturedApi === undefined) {
    return yield* harnessError("load", "Pi did not provide an extension API");
  }
  const pi = capturedApi;
  const context = {
    getSystemPrompt: () => options.systemPrompt ?? "Pi base.",
    isIdle: () => options.idle ?? true,
    ...options.context,
  };

  return {
    context,
    entries,
    extension,
    messages,
    pi,
    emit: Effect.fn("test.pi.emit")((event: string, value: unknown) =>
      Effect.forEach(
        extension.handlers.get(event) ?? [],
        (handler) => invokePiCallable(
          "emit",
          event,
          handler,
          [value, context],
        ),
        { concurrency: 1 },
      )),
    executeCommand: Effect.fn("test.pi.executeCommand")((
      name: string,
      arguments_: string,
    ) => {
      const command = extension.commands.get(name);
      return command === undefined
        ? Effect.fail(harnessError("execute", `Pi command ${name} is not registered`))
        : invokePiCallable(
          "execute",
          `command ${name}`,
          command.handler,
          [arguments_, context],
        );
    }),
    executeTool: Effect.fn("test.pi.executeTool")((
      name: string,
      ...args: ReadonlyArray<unknown>
    ) => {
      const tool = extension.tools.get(name);
      return tool === undefined
        ? Effect.fail(harnessError("execute", `Pi tool ${name} is not registered`))
        : invokePiCallable("execute", name, tool.definition.execute, args);
    }),
  };
});
