import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";

import {
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
} from "effect";

const providerId = "openai-codex";
const markerVersion = 1;
const publicCodexTransportPlaceholder =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiZmxlZXQtZ2F0ZXdheSJ9fQ.placeholder";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const JsonObjectFromString = Schema.fromJsonString(JsonObject);
const UnknownFromString = Schema.fromJsonString(Schema.Unknown);

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
const ProviderMarkerFromString = Schema.fromJsonString(ProviderMarker);

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

const PiProviderLive = Layer.merge(BunFileSystem.layer, BunPath.layer);

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

const readOptionalText = Effect.fn("agentos.piProvider.readOptionalText")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const result = yield* fileSystem.readFileString(path).pipe(Effect.result);
    if (Result.isSuccess(result)) return result.success;
    if (result.failure.reason._tag === "NotFound") return undefined;
    return yield* fileError("read", path, result.failure);
  },
);

function sourceContainsJson(source: string): boolean {
  return Option.isSome(
    Schema.decodeUnknownOption(UnknownFromString)(source),
  );
}

const parseJsonObject = Effect.fn("agentos.piProvider.parseJsonObject")(
  function*(source: string, label: string) {
    return yield* Schema.decodeUnknownEffect(JsonObjectFromString)(source).pipe(
      Effect.mapError(() =>
        configurationError(
          sourceContainsJson(source)
            ? `${label} must contain a JSON object`
            : `${label} must contain valid JSON`,
        )
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
    return yield* Schema.decodeUnknownEffect(ProviderMarkerFromString)(
      source,
    ).pipe(
      Effect.mapError(() =>
        configurationError(
          sourceContainsJson(source)
            ? "pi-provider.json does not match the AgentOS ownership schema"
            : "pi-provider.json must contain valid JSON",
        )
      ),
    );
  },
);

const writePrivateText = Effect.fn("agentos.piProvider.writePrivateText")(
  function*(path: string, source: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    yield* fileSystem.makeDirectory(paths.dirname(path), {
      mode: 0o700,
      recursive: true,
    }).pipe(Effect.mapError((cause) => fileError("write", path, cause)));
    yield* Effect.gen(function*() {
      yield* fileSystem.writeFileString(path, `${source}\n`, { mode: 0o600 });
      yield* fileSystem.chmod(path, 0o600);
    }).pipe(Effect.mapError((cause) => fileError("write", path, cause)));
  },
);

function writePrivateJson(path: string, value: JsonObject) {
  return Schema.encodeEffect(JsonObjectFromString)(value).pipe(
    Effect.mapError(() => configurationError(`Could not encode ${path}`)),
    Effect.flatMap((source) => writePrivateText(path, source)),
  );
}

function writePrivateMarker(path: string, value: ProviderMarker) {
  return Schema.encodeEffect(ProviderMarkerFromString)(value).pipe(
    Effect.mapError(() => configurationError(`Could not encode ${path}`)),
    Effect.flatMap((source) => writePrivateText(path, source)),
  );
}

const renamePrivateFile = Effect.fn("agentos.piProvider.renamePrivateFile")(
  function*(source: string, destination: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.rename(source, destination).pipe(
      Effect.mapError((cause) => fileError("replace", destination, cause)),
    );
  },
);

const removeFile = Effect.fn("agentos.piProvider.removeFile")(function*(
  path: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(path, { force: true }).pipe(
    Effect.mapError((cause) => fileError("remove", path, cause)),
  );
});

function cleanupFiles(paths: ReadonlyArray<string>) {
  return Effect.forEach(paths, (path) => removeFile(path).pipe(Effect.ignore), {
    discard: true,
  });
}

function optionalEnvironment(
  environment: PiConfigurationEnvironment,
  name: string,
) {
  const raw = environment[name];
  if (raw === undefined) return Effect.succeed<string | undefined>(undefined);
  const value = raw.trim();
  return value
    ? Effect.succeed<string | undefined>(value)
    : Effect.fail(
      configurationError(`${name} must be non-empty when configured`),
    );
}

const providerMode = Effect.fn("agentos.piProvider.mode")(
  function*(environment: PiConfigurationEnvironment) {
    const mode = yield* optionalEnvironment(
      environment,
      "AGENTOS_PI_PROVIDER_MODE",
    );
    if (mode === undefined || mode === "ai-gateway" || mode === "direct") {
      return mode satisfies ProviderMode;
    }
    return yield* configurationError(
      "AGENTOS_PI_PROVIDER_MODE must be ai-gateway or direct when configured",
    );
  },
);

const normalizedGatewayUrl = Effect.fn("agentos.piProvider.gatewayUrl")(
  function*(raw: string) {
    const url = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.URLFromString)(raw),
    );
    if (url === undefined) {
      return yield* configurationError("AI_GATEWAY_URL must be an absolute URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return yield* configurationError(
        "AI_GATEWAY_URL must use http or https",
      );
    }
    if (url.username || url.password || url.search || url.hash) {
      return yield* configurationError(
        "AI_GATEWAY_URL must not contain credentials, a query, or a fragment",
      );
    }
    return url.toString().replace(/\/$/, "");
  },
);

const selectedModelParts = Effect.fn("agentos.piProvider.selectedModelParts")(
  function*(selectedModel: string) {
    const separator = selectedModel.indexOf("/");
    if (separator <= 0 || separator === selectedModel.length - 1) {
      return yield* configurationError(
        "AGENTOS_MODEL must use Pi's provider/model form",
      );
    }
    return {
      model: selectedModel.slice(separator + 1),
      provider: selectedModel.slice(0, separator),
    };
  },
);

function gatewayProviderEntry(baseUrl: string): JsonObject {
  return {
    apiKey: publicCodexTransportPlaceholder,
    baseUrl,
  };
}

function optionalRecord(value: unknown): JsonObject | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

const currentState = Effect.fn("agentos.piProvider.currentState")(
  function*(
    settings: JsonObject | undefined,
    models: JsonObject | undefined,
    marker: ProviderMarker | undefined,
  ) {
    const currentModels = models ?? {};
    const providersValue = currentModels.providers;
    const providers = providersValue === undefined
      ? {}
      : optionalRecord(providersValue);
    if (providers === undefined) {
      return yield* configurationError(
        "models.json providers must contain a JSON object",
      );
    }
    const providerValue = providers[providerId];
    const provider = providerValue === undefined
      ? undefined
      : optionalRecord(providerValue);
    if (providerValue !== undefined && provider === undefined) {
      return yield* configurationError(
        "openai-codex provider is not owned by AgentOS",
      );
    }
    return {
      marker,
      models: currentModels,
      provider,
      providers,
      settings: settings ?? {},
    } satisfies ReconciliationState;
  },
);

function optionalEntryEquals(
  left: JsonObject | null | undefined,
  right: JsonObject | null | undefined,
): boolean {
  return isDeepStrictEqual(left ?? null, right ?? null);
}

function assertOwnedState(state: ReconciliationState) {
  const marker = state.marker;
  if (marker === undefined) return Effect.void;
  if (marker._tag === "Active") {
    return state.provider === undefined ||
        isDeepStrictEqual(state.provider, marker.entry)
      ? Effect.void
      : Effect.fail(
        configurationError(
          "openai-codex provider changed outside AgentOS ownership",
        ),
      );
  }
  return optionalEntryEquals(state.provider, marker.previous) ||
      optionalEntryEquals(state.provider, marker.desired)
    ? Effect.void
    : Effect.fail(
      configurationError(
        "openai-codex provider changed during an AgentOS reconciliation",
      ),
    );
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

const selectedSettings = Effect.fn("agentos.piProvider.selectedSettings")(
  function*(
    settings: JsonObject,
    selectedModel: string | undefined,
    selectedThinking: string | undefined,
  ) {
    const selected: Record<string, unknown> = {};
    if (selectedModel !== undefined) {
      const parts = yield* selectedModelParts(selectedModel);
      selected.defaultProvider = parts.provider;
      selected.defaultModel = parts.model;
    }
    if (selectedThinking !== undefined) {
      selected.defaultThinkingLevel = selectedThinking;
    }
    return { ...settings, ...selected };
  },
);

function validationError(cause: unknown, fallback: string) {
  return configurationError(cause instanceof Error ? cause.message : fallback);
}

const validateWithPi = Effect.fn("agentos.piProvider.validateWithPi")(
  function*(options: {
    readonly authPath: string;
    readonly gatewayUrl: string | undefined;
    readonly modelsPath: string;
    readonly mode: ProviderMode;
    readonly selectedModel: string | undefined;
  }) {
    const runtime = yield* Effect.tryPromise({
      try: () =>
        ModelRuntime.create({
          allowModelNetwork: false,
          authPath: options.authPath,
          modelsPath: options.modelsPath,
        }),
      catch: (cause) => validationError(cause, "Pi rejected the prepared provider"),
    });
    if (runtime.getError()) {
      return yield* configurationError("Pi rejected the prepared models.json");
    }

    const selectedModel = options.selectedModel;
    const selected = selectedModel === undefined
      ? undefined
      : yield* Effect.gen(function*() {
        const parts = yield* selectedModelParts(selectedModel);
        const model = runtime.getModel(parts.provider, parts.model);
        if (model === undefined) {
          return yield* configurationError(
            `${selectedModel} is not a pinned Pi model`,
          );
        }
        return model;
      });

    if (options.mode !== "ai-gateway") return;
    const model = selected ?? runtime.getModels(providerId)[0];
    if (model === undefined) {
      return yield* configurationError("Pi exposes no openai-codex models");
    }
    if (model.provider !== providerId || model.baseUrl !== options.gatewayUrl) {
      return yield* configurationError(
        "Pi did not compose the AgentOS Gateway provider",
      );
    }
    const auth = yield* Effect.tryPromise({
      try: () => runtime.getAuth(model, { env: {} }),
      catch: (cause) => validationError(cause, "Pi rejected Gateway transport"),
    });
    if (
      auth?.auth.apiKey !== publicCodexTransportPlaceholder ||
      auth.auth.headers?.["X-AI-Gateway-Token"] !== undefined
    ) {
      return yield* configurationError(
        "Pi did not compose workload-authenticated Gateway transport",
      );
    }
  },
);

export const reconcilePiConfigurationEffect = Effect.fn(
  "agentos.piProvider.reconcile.effect",
)(function*(options: ReconcilePiConfigurationOptions) {
  const paths = yield* Path.Path;
  const settingsPath = paths.join(options.piAgentDirectory, "settings.json");
  const modelsPath = paths.join(options.piAgentDirectory, "models.json");
  const markerPath = paths.join(options.stateDirectory, "pi-provider.json");
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
    const mode = yield* providerMode(options.environment);
    const selectedModel = yield* optionalEnvironment(
      options.environment,
      "AGENTOS_MODEL",
    );
    const selectedThinking = yield* optionalEnvironment(
      options.environment,
      "AGENTOS_THINKING",
    );
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
    const state = yield* currentState(settings, models, marker);
    yield* assertOwnedState(state);

    const gateway = mode === "ai-gateway"
      ? yield* Effect.gen(function*() {
        const rawUrl = yield* optionalEnvironment(
          options.environment,
          "AI_GATEWAY_URL",
        );
        if (rawUrl === undefined) {
          return yield* configurationError(
            "AI_GATEWAY_URL must be configured",
          );
        }
        const gatewayUrl = yield* normalizedGatewayUrl(rawUrl);
        if (selectedModel !== undefined) {
          const parts = yield* selectedModelParts(selectedModel);
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
        return {
          gatewayUrl,
          provider: gatewayProviderEntry(gatewayUrl),
        };
      })
      : undefined;

    const desiredProvider = gateway?.provider;
    const desiredModels =
      mode === "ai-gateway" && desiredProvider !== undefined
        ? withProvider(state, desiredProvider)
        : mode === "direct" && state.marker !== undefined
          ? withoutProvider(state)
          : state.models;
    const desiredSettings = yield* selectedSettings(
      state.settings,
      selectedModel,
      selectedThinking,
    );

    if (models !== undefined || Object.keys(desiredModels).length > 0) {
      yield* writePrivateJson(modelsNext, desiredModels);
    }
    yield* writePrivateJson(settingsNext, desiredSettings);
    yield* writePrivateJson(validationAuth, {});
    yield* validateWithPi({
      authPath: validationAuth,
      gatewayUrl: gateway?.gatewayUrl,
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
      yield* writePrivateMarker(
        markerNext,
        PendingProviderMarker.make({
          desired: desiredProvider ?? null,
          previous: state.provider ?? null,
          version: markerVersion,
        }),
      );
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
        yield* writePrivateMarker(markerNext, active);
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

export function reconcilePiConfiguration(
  options: ReconcilePiConfigurationOptions,
) {
  return reconcilePiConfigurationEffect(options).pipe(
    Effect.provide(PiProviderLive),
  );
}

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
