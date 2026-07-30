import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileCodexOtelConfig } from "../codex-otel.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function fixture(initial = "") {
  const directory = await mkdtemp(join(tmpdir(), "agentos-codex-otel-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.toml");
  if (initial) await writeFile(path, initial, { mode: 0o644 });
  return path;
}

describe("Codex native OTEL bridge", () => {
  test("maps standard OTLP HTTP/protobuf variables and signal endpoints without enabling prompt logs", async () => {
    const path = await fixture(
      [
        'model = "gpt-5.6-sol"',
        "",
        "[projects.\"/workspace\"]",
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
    await reconcileCodexOtelConfig(path, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.agentos:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
        "http://trace-collector.agentos:4318/custom-traces",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_HEADERS:
        "authorization=Bearer%20SEED_SECRET,x-tenant=agentos",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_SDK_DISABLED: "false",
      OTEL_RESOURCE_ATTRIBUTES:
        "deployment.environment.name=production,service.namespace=agentos",
    });

    const source = await readFile(path, "utf8");
    const parsed = Bun.TOML.parse(source) as Record<string, unknown>;
    expect(parsed.model).toBe("gpt-5.6-sol");
    expect(parsed.projects).toEqual({
      "/workspace": { trust_level: "trusted" },
    });
    expect(parsed.otel).toEqual({
      environment: "production",
      exporter: {
        "otlp-http": {
          endpoint: "http://collector.agentos:4318/v1/logs",
          headers: {
            authorization: "Bearer SEED_SECRET",
            "x-tenant": "agentos",
          },
          protocol: "binary",
        },
      },
      log_user_prompt: false,
      metrics_exporter: {
        "otlp-http": {
          endpoint: "http://collector.agentos:4318/v1/metrics",
          headers: {
            authorization: "Bearer SEED_SECRET",
            "x-tenant": "agentos",
          },
          protocol: "binary",
        },
      },
      trace_exporter: {
        "otlp-http": {
          endpoint:
            "http://trace-collector.agentos:4318/custom-traces",
          headers: {
            authorization: "Bearer SEED_SECRET",
            "x-tenant": "agentos",
          },
          protocol: "binary",
        },
      },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await reconcileCodexOtelConfig(path, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.agentos:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
        "http://trace-collector.agentos:4318/custom-traces",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_HEADERS:
        "authorization=Bearer%20SEED_SECRET,x-tenant=agentos",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_SDK_DISABLED: "false",
      OTEL_RESOURCE_ATTRIBUTES:
        "deployment.environment.name=production,service.namespace=agentos",
    });
    expect(await readFile(path, "utf8")).toBe(source);
  });

  test("maps gRPC and signal-specific protocol/header overrides", async () => {
    const path = await fixture();
    await reconcileCodexOtelConfig(path, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.agentos:4317",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-signal=traces",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
    });
    const parsed = Bun.TOML.parse(await readFile(path, "utf8")) as {
      otel: Record<string, unknown>;
    };
    expect(parsed.otel).toEqual({
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
    });
  });

  test("disabled mode replaces stale Codex exporters while preserving unrelated tables", async () => {
    const path = await fixture(
      [
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
      ].join("\n"),
    );
    await chmod(path, 0o644);

    await reconcileCodexOtelConfig(path, {
      OTEL_SDK_DISABLED: "true",
      OTEL_EXPORTER_OTLP_HEADERS:
        "authorization=Bearer%20MUST_NOT_SURVIVE",
    });

    const source = await readFile(path, "utf8");
    const parsed = Bun.TOML.parse(source) as {
      analytics: unknown;
      features: unknown;
      otel: Record<string, unknown>;
    };
    expect(parsed.analytics).toEqual({ enabled: true });
    expect(parsed.features).toEqual({ shell_snapshot: true });
    expect(parsed.otel).toEqual({
      environment: "dev",
      exporter: "none",
      log_user_prompt: false,
      metrics_exporter: "none",
      trace_exporter: "none",
    });
    expect(source).not.toContain("old.invalid");
    expect(source).not.toContain("MUST_NOT_SURVIVE");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("rejects unsupported exporters and protocols without overwriting config", async () => {
    const path = await fixture('model = "gpt-5.6-sol"\n');
    const original = await readFile(path, "utf8");
    await expect(
      reconcileCodexOtelConfig(path, {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.agentos:4318",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/unsupported",
      }),
    ).rejects.toThrow("Unsupported OTEL_EXPORTER_OTLP_PROTOCOL");
    expect(await readFile(path, "utf8")).toBe(original);

    await expect(
      reconcileCodexOtelConfig(path, {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.agentos:4318",
        OTEL_TRACES_EXPORTER: "console",
      }),
    ).rejects.toThrow("Unsupported OTEL_TRACES_EXPORTER");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  const validationBin = process.env.AGENTOS_CODEX_VALIDATION_BIN;
  if (validationBin) {
    test("is accepted by the Fleet-pinned Codex configuration loader", async () => {
      const path = await fixture();
      await reconcileCodexOtelConfig(path, {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_LOGS_EXPORTER: "otlp",
      });
      const child = Bun.spawn(
        [
          validationBin,
          "debug",
          "models",
        ],
        {
          env: {
            ...process.env,
            CODEX_HOME: join(path, ".."),
            NO_PROXY: "127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
          },
          stderr: "pipe",
          stdout: "ignore",
        },
      );
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("Failed to load");
      expect(stderr).not.toContain("config.toml");
    });
  }
});
