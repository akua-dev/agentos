import {
  createExtensionRuntime,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";

import { loadExtensionFromFactory } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";

export class PiTestHarnessError extends Schema.TaggedErrorClass<PiTestHarnessError>()(
  "PiTestHarnessError",
  {
    operation: Schema.Literals(["load", "emit"]),
    detail: Schema.String,
  },
) {}

export interface PiTestHarnessOptions {
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

const invokePiHandler = Effect.fn("test.pi.invokeHandler")(function*(
  event: string,
  handler: (...args: ReadonlyArray<unknown>) => Promise<unknown>,
  value: unknown,
  context: unknown,
) {
  const outcome: unknown = yield* Effect.try({
    try: () => handler(value, context),
    catch: () => harnessError(
      "emit",
      `Pi handler for ${event} failed; handler details are redacted`,
    ),
  });
  if (outcome instanceof Promise) {
    return yield* Effect.tryPromise({
      try: () => outcome,
      catch: () => harnessError(
        "emit",
        `Pi handler for ${event} failed; handler details are redacted`,
      ),
    });
  }
  return outcome;
});

export const makePiTestHarness = Effect.fn("test.pi.makeHarness")(function*(
  options: PiTestHarnessOptions = {},
) {
  let capturedApi: ExtensionAPI | undefined;
  const runtime = createExtensionRuntime();
  const messages: Array<{ readonly message: unknown; readonly options: unknown }> = [];
  runtime.sendMessage = (message, messageOptions) => {
    messages.push({ message, options: messageOptions });
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
  };

  return {
    context,
    extension,
    messages,
    pi,
    emit: Effect.fn("test.pi.emit")((event: string, value: unknown) =>
      Effect.forEach(
        extension.handlers.get(event) ?? [],
        (handler) => invokePiHandler(event, handler, value, context),
        { concurrency: 1 },
      )),
  };
});
