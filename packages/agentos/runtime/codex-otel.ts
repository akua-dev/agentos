import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;
type Signal = "logs" | "metrics" | "traces";
type Protocol = "grpc" | "http/json" | "http/protobuf";

class CredentialHeaderError extends Error {}

interface Exporter {
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  protocol: Protocol;
}

export async function reconcileCodexOtelConfig(
  path: string,
  environment: Environment,
): Promise<void> {
  const source = await readOptional(path);
  let managed: string;
  try {
    managed = buildManagedOtel(environment);
  } catch (error) {
    if (!(error instanceof CredentialHeaderError)) throw error;
    managed = buildManagedOtel({
      ...environment,
      OTEL_SDK_DISABLED: "true",
    });
  }
  const preserved = removeOtelTables(source).trimEnd();
  const next = `${preserved ? `${preserved}\n\n` : ""}${managed}\n`;
  if (source === next) {
    await chmod(path, 0o600);
    return;
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.agentos-next`;
  await writeFile(temporary, next, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function buildManagedOtel(environment: Environment): string {
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
  ] as const) {
    const exporter = disabled
      ? undefined
      : exporterForSignal(environment, signal);
    lines.push(
      exporter
        ? `${field} = ${tomlExporter(exporter)}`
        : `${field} = "none"`,
    );
  }
  return lines.join("\n");
}

function exporterForSignal(
  environment: Environment,
  signal: Signal,
): Exporter | undefined {
  const signalPrefix = `OTEL_${signal.toUpperCase()}_EXPORTER`;
  const selected = (
    environment[signalPrefix] ??
    (hasEndpoint(environment, signal) ? "otlp" : "none")
  )
    .trim()
    .toLowerCase();
  if (selected === "none") return undefined;
  if (selected !== "otlp") {
    throw new Error(`Unsupported ${signalPrefix}: ${selected}`);
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
    throw new Error(
      `Unsupported ${environment[protocolName] ? protocolName : "OTEL_EXPORTER_OTLP_PROTOCOL"}: ${protocol}`,
    );
  }

  const specificEndpoint =
    environment[
      `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`
    ]?.trim();
  const baseEndpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const endpoint = specificEndpoint
    ? validateEndpoint(specificEndpoint)
    : appendSignalPath(validateEndpoint(requiredEndpoint(baseEndpoint)), signal, protocol);
  const headers = parseHeaders(
    environment[
      `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`
    ] ?? environment.OTEL_EXPORTER_OTLP_HEADERS,
  );
  return { endpoint, headers, protocol };
}

function tomlExporter(exporter: Exporter): string {
  const headers = Object.entries(exporter.headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `${tomlString(key)} = ${tomlString(value)}`,
    )
    .join(", ");
  const headerField = headers ? `, headers = { ${headers} }` : "";
  if (exporter.protocol === "grpc") {
    return `{ otlp-grpc = { endpoint = ${tomlString(exporter.endpoint)}${headerField} } }`;
  }
  const protocol =
    exporter.protocol === "http/json" ? "json" : "binary";
  return `{ otlp-http = { endpoint = ${tomlString(exporter.endpoint)}, protocol = ${tomlString(protocol)}${headerField} } }`;
}

function parseHeaders(value: string | undefined): Readonly<Record<string, string>> {
  if (!value?.trim()) return {};
  if (value.length > 8_192) {
    throw new Error("OTEL exporter headers exceed 8192 bytes");
  }
  const result: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error("OTEL exporter headers must use key=value entries");
    }
    const key = decode(entry.slice(0, separator)).trim().toLowerCase();
    const headerValue = decode(entry.slice(separator + 1)).trim();
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) ||
      key.length > 128 ||
      headerValue.length > 1_024 ||
      /[\r\n]/.test(headerValue)
    ) {
      throw new Error("OTEL exporter headers contain an invalid entry");
    }
    if (isCredentialHeader(key)) {
      throw new CredentialHeaderError(
        "OTEL exporter credential headers cannot be persisted in Codex config",
      );
    }
    result[key] = headerValue;
    if (Object.keys(result).length > 64) {
      throw new Error("OTEL exporter headers exceed 64 entries");
    }
  }
  return result;
}

function isCredentialHeader(key: string): boolean {
  return (
    key === "authorization" ||
    key === "proxy-authorization" ||
    key === "cookie" ||
    key === "set-cookie" ||
    /(?:^|[-_])(authentication|api[-_]?key|token|secret|password|credential)(?:$|[-_])/.test(
      key,
    )
  );
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("OTEL exporter headers contain invalid percent encoding");
  }
}

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

function hasEndpoint(environment: Environment, signal: Signal): boolean {
  return Boolean(
    environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
      environment[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`]?.trim(),
  );
}

function requiredEndpoint(value: string | undefined): string {
  if (!value) {
    throw new Error(
      "OTEL_EXPORTER_OTLP_ENDPOINT is required when an OTLP signal exporter is enabled",
    );
  }
  return value;
}

function validateEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OTEL exporter endpoint must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OTEL exporter endpoint must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("OTEL exporter endpoint must not contain credentials");
  }
  return value.replace(/\/+$/, "");
}

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

async function readOptional(path: string): Promise<string> {
  try {
    await stat(path);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
