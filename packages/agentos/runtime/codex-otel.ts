import {
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schema,
} from "effect";

export type CodexOtelEnvironment = Readonly<
  Record<string, string | undefined>
>;
type Signal = "logs" | "metrics" | "traces";
type Protocol = "grpc" | "http/json" | "http/protobuf";

interface Exporter {
  readonly endpoint: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly protocol: Protocol;
}

export class CodexOtelConfigurationError extends Schema.TaggedErrorClass<CodexOtelConfigurationError>()(
  "CodexOtelConfigurationError",
  {
    message: Schema.String,
    reason: Schema.Literals(["credential_header", "invalid_config"]),
  },
) {}

export class CodexOtelFileError extends Schema.TaggedErrorClass<CodexOtelFileError>()(
  "CodexOtelFileError",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.String,
    path: Schema.String,
  },
) {}

function configurationError(
  message: string,
  reason: CodexOtelConfigurationError["reason"] = "invalid_config",
) {
  return CodexOtelConfigurationError.make({ message, reason });
}

function fileError(operation: string, path: string, cause: unknown) {
  return CodexOtelFileError.make({
    cause,
    message: `Could not ${operation} ${path}`,
    operation,
    path,
  });
}

const readOptional = Effect.fn("agentos.codexOtel.readOptional")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const result = yield* fileSystem.readFileString(path).pipe(Effect.result);
    if (Result.isSuccess(result)) return result.success;
    if (result.failure.reason._tag === "NotFound") return "";
    return yield* fileError("read", path, result.failure);
  },
);

export const reconcileCodexOtelConfig = Effect.fn(
  "agentos.codexOtel.reconcile",
)(function*(path: string, environment: CodexOtelEnvironment) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const source = yield* readOptional(path);
  const managed = yield* buildManagedOtel(environment).pipe(
    Effect.catchTag("CodexOtelConfigurationError", (error) =>
      error.reason === "credential_header"
        ? buildManagedOtel({ ...environment, OTEL_SDK_DISABLED: "true" })
        : Effect.fail(error)
    ),
  );
  const preserved = removeOtelTables(source).trimEnd();
  const next = `${preserved ? `${preserved}\n\n` : ""}${managed}\n`;
  if (source === next) {
    yield* fileSystem.chmod(path, 0o600).pipe(
      Effect.mapError((cause) => fileError("chmod", path, cause)),
    );
    return;
  }

  yield* fileSystem.makeDirectory(paths.dirname(path), {
    recursive: true,
    mode: 0o700,
  }).pipe(Effect.mapError((cause) => fileError("write", path, cause)));
  const temporary = `${path}.agentos-next`;
  yield* Effect.gen(function*() {
    yield* fileSystem.writeFileString(temporary, next, { mode: 0o600 });
    yield* fileSystem.chmod(temporary, 0o600);
    yield* fileSystem.rename(temporary, path);
  }).pipe(
    Effect.mapError((cause) => fileError("write", path, cause)),
    Effect.ensuring(
      fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore),
    ),
  );
});

const buildManagedOtel = Effect.fn("agentos.codexOtel.buildManaged")(
  function*(environment: CodexOtelEnvironment) {
    const disabled =
      environment.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true";
    const deploymentEnvironment =
      resourceAttribute(
        environment.OTEL_RESOURCE_ATTRIBUTES,
        "deployment.environment.name",
      ) ?? "dev";
    const lines = [
      "[otel]",
      "log_user_prompt = false",
      `environment = ${tomlString(deploymentEnvironment)}`,
    ];

    for (const [field, signal] of [
      ["exporter", "logs"],
      ["trace_exporter", "traces"],
      ["metrics_exporter", "metrics"],
    ] satisfies ReadonlyArray<readonly [string, Signal]>) {
      const exporter = disabled
        ? undefined
        : yield* exporterForSignal(environment, signal);
      lines.push(
        exporter
          ? `${field} = ${tomlExporter(exporter)}`
          : `${field} = "none"`,
      );
    }
    return lines.join("\n");
  },
);

const exporterForSignal = Effect.fn("agentos.codexOtel.exporter")(
  function*(environment: CodexOtelEnvironment, signal: Signal) {
    const signalPrefix = `OTEL_${signal.toUpperCase()}_EXPORTER`;
    const selected = (
      environment[signalPrefix] ??
      (hasEndpoint(environment, signal) ? "otlp" : "none")
    ).trim().toLowerCase();
    if (selected === "none") return undefined;
    if (selected !== "otlp") {
      return yield* configurationError(
        `Unsupported ${signalPrefix}: ${selected}`,
      );
    }

    const protocolName = `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_PROTOCOL`;
    const rawProtocol =
      environment[protocolName] ??
      environment.OTEL_EXPORTER_OTLP_PROTOCOL ??
      "http/protobuf";
    const protocol = rawProtocol.trim().toLowerCase();
    if (
      protocol !== "grpc" &&
      protocol !== "http/json" &&
      protocol !== "http/protobuf"
    ) {
      return yield* configurationError(
        `Unsupported ${environment[protocolName] ? protocolName : "OTEL_EXPORTER_OTLP_PROTOCOL"}: ${protocol}`,
      );
    }

    const specificEndpoint =
      environment[
        `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`
      ]?.trim();
    const baseEndpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
    const endpoint = specificEndpoint
      ? yield* validateEndpoint(specificEndpoint)
      : appendSignalPath(
        yield* validateEndpoint(yield* requiredEndpoint(baseEndpoint)),
        signal,
        protocol,
      );
    const headers = yield* parseHeaders(
      environment[
        `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`
      ] ?? environment.OTEL_EXPORTER_OTLP_HEADERS,
    );
    return { endpoint, headers, protocol } satisfies Exporter;
  },
);

function tomlExporter(exporter: Exporter): string {
  const headers = Object.entries(exporter.headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(", ");
  const headerField = headers ? `, headers = { ${headers} }` : "";
  if (exporter.protocol === "grpc") {
    return `{ otlp-grpc = { endpoint = ${tomlString(exporter.endpoint)}${headerField} } }`;
  }
  const protocol = exporter.protocol === "http/json" ? "json" : "binary";
  return `{ otlp-http = { endpoint = ${tomlString(exporter.endpoint)}, protocol = ${tomlString(protocol)}${headerField} } }`;
}

const parseHeaders = Effect.fn("agentos.codexOtel.parseHeaders")(
  function*(value: string | undefined) {
    if (!value?.trim()) return {};
    if (value.length > 8_192) {
      return yield* configurationError(
        "OTEL exporter headers exceed 8192 bytes",
      );
    }
    const result: Record<string, string> = {};
    for (const entry of value.split(",")) {
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        return yield* configurationError(
          "OTEL exporter headers must use key=value entries",
        );
      }
      const key = (yield* decode(entry.slice(0, separator))).trim()
        .toLowerCase();
      const headerValue = (yield* decode(entry.slice(separator + 1))).trim();
      if (
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) ||
        key.length > 128 ||
        headerValue.length > 1_024 ||
        /[\r\n]/.test(headerValue)
      ) {
        return yield* configurationError(
          "OTEL exporter headers contain an invalid entry",
        );
      }
      if (isCredentialHeader(key)) {
        return yield* configurationError(
          "OTEL exporter credential headers cannot be persisted in Codex config",
          "credential_header",
        );
      }
      result[key] = headerValue;
      if (Object.keys(result).length > 64) {
        return yield* configurationError(
          "OTEL exporter headers exceed 64 entries",
        );
      }
    }
    return result;
  },
);

function isCredentialHeader(key: string): boolean {
  return key === "authorization" ||
    key === "proxy-authorization" ||
    key === "cookie" ||
    key === "set-cookie" ||
    /(?:^|[-_])(authentication|api[-_]?key|token|secret|password|credential)(?:$|[-_])/.test(
      key,
    );
}

const decode = Effect.fn("agentos.codexOtel.decodeHeader")(function*(
  value: string,
) {
  return yield* Effect.try({
    try: () => decodeURIComponent(value),
    catch: () =>
      configurationError(
        "OTEL exporter headers contain invalid percent encoding",
      ),
  });
});

function resourceAttribute(
  value: string | undefined,
  selectedKey: string,
): string | undefined {
  for (const entry of value?.split(",") ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    if (entry.slice(0, separator).trim() !== selectedKey) continue;
    const selected = entry.slice(separator + 1).trim();
    if (
      selected &&
      selected.length <= 64 &&
      /^[0-9A-Za-z._-]+$/.test(selected)
    ) {
      return selected;
    }
  }
  return undefined;
}

function removeOtelTables(source: string): string {
  let skip = false;
  const lines: string[] = [];
  for (const line of source.split("\n")) {
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/);
    if (header) {
      const table = header[1]?.trim() ?? "";
      skip = table === "otel" || table.startsWith("otel.");
    }
    if (!skip) lines.push(line);
  }
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function hasEndpoint(
  environment: CodexOtelEnvironment,
  signal: Signal,
): boolean {
  return Boolean(
    environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
      environment[
        `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`
      ]?.trim(),
  );
}

function requiredEndpoint(value: string | undefined) {
  return value
    ? Effect.succeed(value)
    : Effect.fail(
      configurationError(
        "OTEL_EXPORTER_OTLP_ENDPOINT is required when an OTLP signal exporter is enabled",
      ),
    );
}

const validateEndpoint = Effect.fn("agentos.codexOtel.validateEndpoint")(
  function*(value: string) {
    const url = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.URLFromString)(value),
    );
    if (url === undefined) {
      return yield* configurationError(
        "OTEL exporter endpoint must be a valid URL",
      );
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return yield* configurationError(
        "OTEL exporter endpoint must use http or https",
      );
    }
    if (url.username || url.password) {
      return yield* configurationError(
        "OTEL exporter endpoint must not contain credentials",
      );
    }
    return value.replace(/\/+$/, "");
  },
);

function appendSignalPath(
  endpoint: string,
  signal: Signal,
  protocol: Protocol,
): string {
  return protocol === "grpc" ? endpoint : `${endpoint}/v1/${signal}`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
