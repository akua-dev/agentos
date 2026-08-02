import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema, Scope } from "effect";

import { reconcileCodexOtelConfig } from "../codex-otel.ts";

const TomlDocument = Schema.Record(Schema.String, Schema.Unknown);

const withPlatform = <A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(BunServices.layer));

const fixture = Effect.fn("test.codexOtel.fixture")(function*(initial = "") {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "agentos-codex-otel-",
  });
  const path = paths.join(directory, "config.toml");
  if (initial) yield* fileSystem.writeFileString(path, initial, { mode: 0o644 });
  return path;
});

const parseToml = Effect.fn("test.codexOtel.parseToml")(function*(source: string) {
  const parsed = yield* Effect.try({
    try: () => Bun.TOML.parse(source),
    catch: (cause) => cause,
  });
  return yield* Schema.decodeUnknownEffect(TomlDocument)(parsed);
});

describe("Codex native OTEL bridge", () => {
  it.effect("maps standard OTLP HTTP/protobuf variables and signal endpoints without enabling prompt logs", () =>
    withPlatform(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* fixture([
        'model = "gpt-5.6-sol"',
        "",
        "[projects.\"/workspace\"]",
        'trust_level = "trusted"',
        "",
      ].join("\n"));
      const environment = {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.agentos:4318",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://trace-collector.agentos:4318/custom-traces",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        OTEL_EXPORTER_OTLP_HEADERS: "x-tenant=agentos",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_SDK_DISABLED: "false",
        OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=production,service.namespace=agentos",
      };
      yield* reconcileCodexOtelConfig(path, environment);
      const source = yield* fileSystem.readFileString(path);
      expect(yield* parseToml(source)).toEqual({
        model: "gpt-5.6-sol",
        projects: { "/workspace": { trust_level: "trusted" } },
        otel: {
          environment: "production",
          exporter: {
            "otlp-http": {
              endpoint: "http://collector.agentos:4318/v1/logs",
              headers: { "x-tenant": "agentos" },
              protocol: "binary",
            },
          },
          log_user_prompt: false,
          metrics_exporter: {
            "otlp-http": {
              endpoint: "http://collector.agentos:4318/v1/metrics",
              headers: { "x-tenant": "agentos" },
              protocol: "binary",
            },
          },
          trace_exporter: {
            "otlp-http": {
              endpoint: "http://trace-collector.agentos:4318/custom-traces",
              headers: { "x-tenant": "agentos" },
              protocol: "binary",
            },
          },
        },
      });
      expect(Number((yield* fileSystem.stat(path)).mode) & 0o777).toBe(0o600);
      yield* reconcileCodexOtelConfig(path, environment);
      expect(yield* fileSystem.readFileString(path)).toBe(source);
    }))
  );

  it.effect("maps gRPC and signal-specific protocol/header overrides", () =>
    withPlatform(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* fixture();
      yield* reconcileCodexOtelConfig(path, {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.agentos:4317",
        OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-signal=traces",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "none",
        OTEL_LOGS_EXPORTER: "none",
      });
      expect(yield* parseToml(yield* fileSystem.readFileString(path))).toEqual({
        otel: {
          environment: "dev",
          exporter: "none",
          log_user_prompt: false,
          metrics_exporter: "none",
          trace_exporter: {
            "otlp-grpc": {
              endpoint: "https://collector.agentos:4317",
              headers: { "x-signal": "traces" },
            },
          },
        },
      });
    }))
  );

  it.effect("uses a signal-specific endpoint without enabling signals lacking endpoints", () =>
    withPlatform(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* fixture();
      yield* reconcileCodexOtelConfig(path, {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.agentos:4318/custom-traces",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-signal=traces",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_SDK_DISABLED: "false",
      });
      expect(yield* parseToml(yield* fileSystem.readFileString(path))).toEqual({
        otel: {
          environment: "dev",
          exporter: "none",
          log_user_prompt: false,
          metrics_exporter: "none",
          trace_exporter: {
            "otlp-http": {
              endpoint: "https://traces.agentos:4318/custom-traces",
              headers: { "x-signal": "traces" },
              protocol: "binary",
            },
          },
        },
      });
    }))
  );

  it.effect("disabled mode replaces stale Codex exporters while preserving unrelated tables", () =>
    withPlatform(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* fixture([
        "[analytics]",
        "enabled = true",
        "",
        "[otel]",
        "log_user_prompt = true",
        'trace_exporter = { otlp-grpc = { endpoint = "https://old.invalid" } }',
        "",
        "[otel.span_attributes]",
        '"private" = "old"',
        "",
        "[features]",
        "shell_snapshot = true",
        "",
      ].join("\n"));
      yield* fileSystem.chmod(path, 0o644);
      yield* reconcileCodexOtelConfig(path, {
        OTEL_SDK_DISABLED: "true",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20MUST_NOT_SURVIVE",
      });
      const source = yield* fileSystem.readFileString(path);
      expect(yield* parseToml(source)).toEqual({
        analytics: { enabled: true },
        features: { shell_snapshot: true },
        otel: {
          environment: "dev",
          exporter: "none",
          log_user_prompt: false,
          metrics_exporter: "none",
          trace_exporter: "none",
        },
      });
      expect(source).not.toContain("old.invalid");
      expect(source).not.toContain("MUST_NOT_SURVIVE");
      expect(Number((yield* fileSystem.stat(path)).mode) & 0o777).toBe(0o600);
    }))
  );

  it.effect("rejects unsupported exporters and protocols without overwriting config", () =>
    withPlatform(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* fixture('model = "gpt-5.6-sol"\n');
      const original = yield* fileSystem.readFileString(path);
      const protocolError = yield* reconcileCodexOtelConfig(path, {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.agentos:4318",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/unsupported",
      }).pipe(Effect.flip);
      expect(protocolError.message).toContain("Unsupported OTEL_EXPORTER_OTLP_PROTOCOL");
      expect(yield* fileSystem.readFileString(path)).toBe(original);
      const exporterError = yield* reconcileCodexOtelConfig(path, {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.agentos:4318",
        OTEL_TRACES_EXPORTER: "console",
      }).pipe(Effect.flip);
      expect(exporterError.message).toContain("Unsupported OTEL_TRACES_EXPORTER");
      expect(yield* fileSystem.readFileString(path)).toBe(original);
    }))
  );

  it.effect("disables Codex exporters when credentials cannot be persisted", () =>
    withPlatform(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* fixture([
        'model = "gpt-5.6-sol"',
        "",
        "[otel]",
        'trace_exporter = { otlp-http = { endpoint = "https://old.invalid", headers = { authorization = "OLD_SECRET" } } }',
        "",
      ].join("\n"));
      yield* reconcileCodexOtelConfig(path, {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.agentos:4318",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20MUST_NOT_BE_WRITTEN",
      });
      const source = yield* fileSystem.readFileString(path);
      expect(yield* parseToml(source)).toEqual({
        model: "gpt-5.6-sol",
        otel: {
          environment: "dev",
          exporter: "none",
          log_user_prompt: false,
          metrics_exporter: "none",
          trace_exporter: "none",
        },
      });
      expect(source).not.toContain("MUST_NOT_BE_WRITTEN");
      expect(source).not.toContain("OLD_SECRET");
      expect(Number((yield* fileSystem.stat(path)).mode) & 0o777).toBe(0o600);
    }))
  );
});
