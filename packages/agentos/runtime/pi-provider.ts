import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const providerId = "openai-codex";
const markerVersion = 1;
const publicCodexTransportPlaceholder =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiZmxlZXQtZ2F0ZXdheSJ9fQ.placeholder";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

class ActiveProviderMarker extends Schema.TaggedClass<ActiveProviderMarker>()(
  "Active",
  {
    entry: JsonObject,
    version: Schema.Literal(markerVersion),
  },
) {}

class PendingProviderMarker extends Schema.TaggedClass<PendingProviderMarker>()(
  "Pending",
  {
    desired: Schema.NullOr(JsonObject),
    previous: Schema.NullOr(JsonObject),
    version: Schema.Literal(markerVersion),
  },
) {}

const ProviderMarker = Schema.Union([
  ActiveProviderMarker,
  PendingProviderMarker,
]);

type JsonObject = typeof JsonObject.Type;
type ProviderMarker = typeof ProviderMarker.Type;
type ProviderMode = "ai-gateway" | "direct" | undefined;

export class PiProviderConfigurationError extends Schema.TaggedErrorClass<PiProviderConfigurationError>()(
  "PiProviderConfigurationError",
  {
    message: Schema.String,
  },
) {}

export class PiProviderFileError extends Schema.TaggedErrorClass<PiProviderFileError>()(
  "PiProviderFileError",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
    path: Schema.String,
  },
) {}

export type PiConfigurationEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ReconcilePiConfigurationOptions = {
  readonly environment: PiConfigurationEnvironment;
  readonly piAgentDirectory: string;
  readonly stateDirectory: string;
};

type ReconciliationState = {
  readonly marker: ProviderMarker | undefined;
  readonly models: JsonObject;
  readonly provider: JsonObject | undefined;
  readonly providers: JsonObject;
  readonly settings: JsonObject;
};

function isMissingFile(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

function fileError(operation: string, path: string, cause: unknown) {
  return PiProviderFileError.make({
    cause,
    message: `Could not ${operation} ${path}`,
    operation,
    path,
  });
}

function configurationError(message: string) {
  return PiProviderConfigurationError.make({ message });
}

function parseUnknownJson(source: string): unknown {
  return JSON.parse(source);
}

const readOptionalText = Effect.fn("agentos.piProvider.readOptionalText")(
  function*(path: string) {
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readFile(path, "utf8");
        } catch (cause) {
          if (isMissingFile(cause)) return undefined;
          throw cause;
        }
      },
      catch: (cause) => fileError("read", path, cause),
    });
  },
);

const parseJsonObject = Effect.fn("agentos.piProvider.parseJsonObject")(
  function*(source: string, label: string) {
    const parsed = yield* Effect.try({
      try: () => parseUnknownJson(source),
      catch: () =>
        configurationError(`${label} must contain valid JSON`),
    });
    return yield* Schema.decodeUnknownEffect(JsonObject)(parsed).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(
          configurationError(`${label} must contain a JSON object`),
        ),
      ),
    );
  },
);

const readOptionalJsonObject = Effect.fn(
  "agentos.piProvider.readOptionalJsonObject",
)(function*(path: string, label: string) {
  const source = yield* readOptionalText(path);
  if (source === undefined) return undefined;
  return yield* parseJsonObject(source, label);
});

const readOptionalMarker = Effect.fn("agentos.piProvider.readOptionalMarker")(
  function*(path: string) {
    const source = yield* readOptionalText(path);
    if (source === undefined) return undefined;
    const parsed = yield* Effect.try({
      try: () => parseUnknownJson(source),
      catch: () =>
        configurationError("pi-provider.json must contain valid JSON"),
    });
    return yield* Schema.decodeUnknownEffect(ProviderMarker)(parsed).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(
          configurationError(
            "pi-provider.json does not match the AgentOS ownership schema",
          ),
        ),
      ),
    );
  },
);

const writePrivateJson = Effect.fn("agentos.piProvider.writePrivateJson")(
  function*(path: string, value: unknown) {
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { mode: 0o700, recursive: true });
        await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
          mode: 0o600,
        });
        await chmod(path, 0o600);
      },
      catch: (cause) => fileError("write", path, cause),
    });
  },
);

const renamePrivateFile = Effect.fn("agentos.piProvider.renamePrivateFile")(
  function*(source: string, destination: string) {
    yield* Effect.tryPromise({
      try: () => rename(source, destination),
      catch: (cause) => fileError("replace", destination, cause),
    });
  },
);

const removeFile = Effect.fn("agentos.piProvider.removeFile")(function*(
  path: string,
) {
  yield* Effect.tryPromise({
    try: () => rm(path, { force: true }),
    catch: (cause) => fileError("remove", path, cause),
  });
});

function cleanupFiles(paths: ReadonlyArray<string>) {
  return Effect.forEach(
    paths,
    (path) => removeFile(path).pipe(Effect.ignore),
    { discard: true },
  );
}

function optionalEnvironment(
  environment: PiConfigurationEnvironment,
  name: string,
): string | undefined {
  const raw = environment[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!value) throw configurationError(`${name} must be non-empty when configured`);
  return value;
}

function providerMode(environment: PiConfigurationEnvironment): ProviderMode {
  const mode = optionalEnvironment(environment, "AGENTOS_PI_PROVIDER_MODE");
  if (mode === undefined || mode === "ai-gateway" || mode === "direct") {
    return mode;
  }
  throw configurationError(
    "AGENTOS_PI_PROVIDER_MODE must be ai-gateway or direct when configured",
  );
}

function normalizedGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configurationError("AI_GATEWAY_URL must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configurationError("AI_GATEWAY_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw configurationError(
      "AI_GATEWAY_URL must not contain credentials, a query, or a fragment",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function selectedModelParts(selectedModel: string): {
  readonly model: string;
  readonly provider: string;
} {
  const separator = selectedModel.indexOf("/");
  if (separator <= 0 || separator === selectedModel.length - 1) {
    throw configurationError(
      "AGENTOS_MODEL must use Pi's provider/model form",
    );
  }
  return {
    model: selectedModel.slice(separator + 1),
    provider: selectedModel.slice(0, separator),
  };
}

function gatewayProviderEntry(baseUrl: string): JsonObject {
  return {
    apiKey: publicCodexTransportPlaceholder,
    baseUrl,
    headers: { "X-AI-Gateway-Token": "$AI_GATEWAY_TOKEN" },
  };
}

function optionalRecord(value: unknown): JsonObject | undefined {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object"
  ) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function currentState(
  settings: JsonObject | undefined,
  models: JsonObject | undefined,
  marker: ProviderMarker | undefined,
): ReconciliationState {
  const currentModels = models ?? {};
  const providersValue = currentModels.providers;
  const providers =
    providersValue === undefined ? {} : optionalRecord(providersValue);
  if (providers === undefined) {
    throw configurationError(
      "models.json providers must contain a JSON object",
    );
  }
  const providerValue = providers[providerId];
  const provider =
    providerValue === undefined ? undefined : optionalRecord(providerValue);
  if (providerValue !== undefined && provider === undefined) {
    throw configurationError(
      "openai-codex provider is not owned by AgentOS",
    );
  }
  return {
    marker,
    models: currentModels,
    provider,
    providers,
    settings: settings ?? {},
  };
}

function optionalEntryEquals(
  left: JsonObject | null | undefined,
  right: JsonObject | null | undefined,
): boolean {
  return isDeepStrictEqual(left ?? null, right ?? null);
}

function assertOwnedState(state: ReconciliationState): void {
  const marker = state.marker;
  if (marker === undefined) return;
  if (marker._tag === "Active") {
    if (
      state.provider !== undefined &&
      !isDeepStrictEqual(state.provider, marker.entry)
    ) {
      throw configurationError(
        "openai-codex provider changed outside AgentOS ownership",
      );
    }
    return;
  }
  if (
    !optionalEntryEquals(state.provider, marker.previous) &&
    !optionalEntryEquals(state.provider, marker.desired)
  ) {
    throw configurationError(
      "openai-codex provider changed during an AgentOS reconciliation",
    );
  }
}

function withProvider(
  state: ReconciliationState,
  provider: JsonObject,
): JsonObject {
  return {
    ...state.models,
    providers: { ...state.providers, [providerId]: provider },
  };
}

function withoutProvider(state: ReconciliationState): JsonObject {
  return {
    ...state.models,
    providers: Object.fromEntries(
      Object.entries(state.providers).filter(([name]) => name !== providerId),
    ),
  };
}

function selectedSettings(
  settings: JsonObject,
  selectedModel: string | undefined,
  selectedThinking: string | undefined,
): JsonObject {
  const selected: Record<string, unknown> = {};
  if (selectedModel !== undefined) {
    const parts = selectedModelParts(selectedModel);
    selected.defaultProvider = parts.provider;
    selected.defaultModel = parts.model;
  }
  if (selectedThinking !== undefined) {
    selected.defaultThinkingLevel = selectedThinking;
  }
  return { ...settings, ...selected };
}

const validateWithPi = Effect.fn("agentos.piProvider.validateWithPi")(
  function*(options: {
    readonly authPath: string;
    readonly gatewayToken: string | undefined;
    readonly gatewayUrl: string | undefined;
    readonly modelsPath: string;
    readonly mode: ProviderMode;
    readonly selectedModel: string | undefined;
  }) {
    yield* Effect.tryPromise({
      try: async () => {
        const runtime = await ModelRuntime.create({
          allowModelNetwork: false,
          authPath: options.authPath,
          modelsPath: options.modelsPath,
        });
        const loadError = runtime.getError();
        if (loadError) {
          throw new Error("Pi rejected the prepared models.json");
        }

        let selected;
        if (options.selectedModel !== undefined) {
          const parts = selectedModelParts(options.selectedModel);
          selected = runtime.getModel(parts.provider, parts.model);
          if (!selected) {
            throw new Error(
              `${options.selectedModel} is not a pinned Pi model`,
            );
          }
        }

        if (options.mode !== "ai-gateway") return;
        const model = selected ?? runtime.getModels(providerId)[0];
        if (!model) {
          throw new Error("Pi exposes no openai-codex models");
        }
        if (model.provider !== providerId || model.baseUrl !== options.gatewayUrl) {
          throw new Error("Pi did not compose the AgentOS Gateway provider");
        }
        const auth = await runtime.getAuth(model, {
          env: { AI_GATEWAY_TOKEN: options.gatewayToken ?? "" },
        });
        if (
          auth?.auth.headers?.["X-AI-Gateway-Token"] !== options.gatewayToken
        ) {
          throw new Error("Pi did not resolve the Gateway token header");
        }
      },
      catch: (cause) =>
        configurationError(
          cause instanceof Error
            ? cause.message
            : "Pi rejected the prepared provider",
        ),
    });
  },
);

export const reconcilePiConfiguration = Effect.fn(
  "agentos.piProvider.reconcilePiConfiguration",
)(function*(options: ReconcilePiConfigurationOptions) {
  const settingsPath = join(options.piAgentDirectory, "settings.json");
  const modelsPath = join(options.piAgentDirectory, "models.json");
  const markerPath = join(options.stateDirectory, "pi-provider.json");
  const settingsNext = `${settingsPath}.agentos-next`;
  const modelsNext = `${modelsPath}.agentos-next`;
  const validationAuth = `${modelsNext}.auth`;
  const markerNext = `${markerPath}.agentos-next`;
  const cleanup = cleanupFiles([
    settingsNext,
    modelsNext,
    validationAuth,
    markerNext,
  ]);

  return yield* Effect.gen(function*() {
    const mode = yield* Effect.try({
      try: () => providerMode(options.environment),
      catch: (cause) =>
        cause instanceof PiProviderConfigurationError
          ? cause
          : configurationError("Invalid Pi provider mode"),
    });
    const selectedModel = yield* Effect.try({
      try: () => optionalEnvironment(options.environment, "AGENTOS_MODEL"),
      catch: (cause) =>
        cause instanceof PiProviderConfigurationError
          ? cause
          : configurationError("Invalid AGENTOS_MODEL"),
    });
    const selectedThinking = yield* Effect.try({
      try: () => optionalEnvironment(options.environment, "AGENTOS_THINKING"),
      catch: (cause) =>
        cause instanceof PiProviderConfigurationError
          ? cause
          : configurationError("Invalid AGENTOS_THINKING"),
    });
    const marker = yield* readOptionalMarker(markerPath);
    if (mode === undefined && marker !== undefined) {
      return yield* configurationError(
        "AGENTOS_PI_PROVIDER_MODE must remain configured until direct rollback completes",
      );
    }
    if (
      mode === undefined &&
      selectedModel === undefined &&
      selectedThinking === undefined
    ) {
      return unchangedResult();
    }

    const [settings, models] = yield* Effect.all([
      readOptionalJsonObject(settingsPath, "settings.json"),
      readOptionalJsonObject(modelsPath, "models.json"),
    ]);
    const state = yield* Effect.try({
      try: () => currentState(settings, models, marker),
      catch: (cause) =>
        cause instanceof PiProviderConfigurationError
          ? cause
          : configurationError("Invalid Pi configuration"),
    });
    yield* Effect.try({
      try: () => assertOwnedState(state),
      catch: (cause) =>
        cause instanceof PiProviderConfigurationError
          ? cause
          : configurationError("Invalid AgentOS provider ownership"),
    });

    let gatewayUrl: string | undefined;
    let gatewayToken: string | undefined;
    let desiredProvider: JsonObject | undefined;
    if (mode === "ai-gateway") {
      gatewayUrl = yield* Effect.try({
        try: () => {
          const raw = optionalEnvironment(options.environment, "AI_GATEWAY_URL");
          if (raw === undefined) {
            throw configurationError("AI_GATEWAY_URL must be configured");
          }
          return normalizedGatewayUrl(raw);
        },
        catch: (cause) =>
          cause instanceof PiProviderConfigurationError
            ? cause
            : configurationError("Invalid AI_GATEWAY_URL"),
      });
      gatewayToken = yield* Effect.try({
        try: () => {
          const token = optionalEnvironment(
            options.environment,
            "AI_GATEWAY_TOKEN",
          );
          if (token === undefined) {
            throw configurationError("AI_GATEWAY_TOKEN must be configured");
          }
          return token;
        },
        catch: (cause) =>
          cause instanceof PiProviderConfigurationError
            ? cause
            : configurationError("Invalid AI_GATEWAY_TOKEN"),
      });
      if (selectedModel !== undefined) {
        const parts = yield* Effect.try({
          try: () => selectedModelParts(selectedModel),
          catch: (cause) =>
            cause instanceof PiProviderConfigurationError
              ? cause
              : configurationError("Invalid AGENTOS_MODEL"),
        });
        if (parts.provider !== providerId) {
          return yield* configurationError(
            "Gateway mode must select openai-codex when AGENTOS_MODEL is configured",
          );
        }
      }
      if (state.marker === undefined && state.provider !== undefined) {
        return yield* configurationError(
          "openai-codex provider is not owned by AgentOS",
        );
      }
      desiredProvider = gatewayProviderEntry(gatewayUrl);
    }

    const desiredModels =
      mode === "ai-gateway" && desiredProvider !== undefined
        ? withProvider(state, desiredProvider)
        : mode === "direct" && state.marker !== undefined
          ? withoutProvider(state)
          : state.models;
    const desiredSettings = yield* Effect.try({
      try: () =>
        selectedSettings(state.settings, selectedModel, selectedThinking),
      catch: (cause) =>
        cause instanceof PiProviderConfigurationError
          ? cause
          : configurationError("Invalid selected Pi defaults"),
    });

    yield* writePrivateJson(modelsNext, desiredModels);
    yield* writePrivateJson(settingsNext, desiredSettings);
    yield* writePrivateJson(validationAuth, {});
    yield* validateWithPi({
      authPath: validationAuth,
      gatewayToken,
      gatewayUrl,
      modelsPath: modelsNext,
      mode,
      selectedModel,
    });

    const providerChanges = !optionalEntryEquals(
      state.provider,
      desiredProvider,
    );
    const ownsProvider = state.marker !== undefined || mode === "ai-gateway";
    if (ownsProvider && (providerChanges || state.marker?._tag !== "Active")) {
      const pending = PendingProviderMarker.make({
        desired: desiredProvider ?? null,
        previous: state.provider ?? null,
        version: markerVersion,
      });
      yield* writePrivateJson(markerNext, pending);
      yield* renamePrivateFile(markerNext, markerPath);
    }

    if (!isDeepStrictEqual(state.models, desiredModels)) {
      yield* renamePrivateFile(modelsNext, modelsPath);
    } else {
      yield* removeFile(modelsNext);
    }

    if (mode === "ai-gateway" && desiredProvider !== undefined) {
      const active = ActiveProviderMarker.make({
        entry: desiredProvider,
        version: markerVersion,
      });
      if (!isDeepStrictEqual(state.marker, active)) {
        yield* writePrivateJson(markerNext, active);
        yield* renamePrivateFile(markerNext, markerPath);
      }
    } else if (mode === "direct" && state.marker !== undefined) {
      yield* removeFile(markerPath);
    }

    if (!isDeepStrictEqual(state.settings, desiredSettings)) {
      yield* renamePrivateFile(settingsNext, settingsPath);
    } else {
      yield* removeFile(settingsNext);
    }

    return reconciledResult(mode ?? "direct", selectedModel);
  }).pipe(Effect.ensuring(cleanup));
});

function unchangedResult(): {
  readonly mode: "unchanged";
  readonly selectedModel?: undefined;
} {
  return { mode: "unchanged" };
}

function reconciledResult(
  mode: Exclude<ProviderMode, undefined>,
  selectedModel: string | undefined,
): {
  readonly mode: Exclude<ProviderMode, undefined>;
  readonly selectedModel: string | undefined;
} {
  return { mode, selectedModel };
}
