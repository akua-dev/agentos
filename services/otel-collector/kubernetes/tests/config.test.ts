import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const kubernetesDirectory = new URL("..", import.meta.url).pathname;
const collectorImage =
  "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6";

type Resource = {
  kind: string;
  metadata: { name: string };
  data?: Record<string, string>;
};

async function renderConfig(relativeDirectory: string): Promise<string> {
  const directory = join(kubernetesDirectory, relativeDirectory);
  const child = Bun.spawn(["kubectl", "kustomize", directory], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const resources = Bun.YAML.parse(stdout) as Resource[];
  const configMap = resources.find(
    (resource) =>
      resource.kind === "ConfigMap" &&
      resource.metadata.name === "agentos-otel-collector",
  );
  const config = configMap?.data?.["collector.yaml"];
  if (!config) throw new Error("Rendered Collector config is missing");
  return config;
}

async function validate(
  config: string,
  remote: boolean,
): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "agentos-otel-config-"));
  const path = join(directory, "collector.yaml");
  const headersPath = join(directory, "headers.yaml");
  await writeFile(path, config, "utf8");
  await writeFile(
    headersPath,
    [
      "exporters:",
      "  otlp_http/remote:",
      "    headers:",
      '      authorization: "redacted-test-value"',
      "",
    ].join("\n"),
    "utf8",
  );
  try {
    const configArguments = [
      "--config=file:/etc/otelcol/collector.yaml",
      ...(remote
        ? ["--config=file:/etc/otelcol-secret/headers.yaml"]
        : []),
    ];
    const child = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "-e",
        "K8S_NODE_NAME=test-node",
        "-e",
        "OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.test",
        "-v",
        `${path}:/etc/otelcol/collector.yaml:ro`,
        "-v",
        `${headersPath}:/etc/otelcol-secret/headers.yaml:ro`,
        collectorImage,
        "validate",
        ...configArguments,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stderr, stdout };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("Collector configuration", () => {
  for (const directory of [
    "base",
    "overlays/remote",
    "overlays/local-diagnostics",
  ]) {
    test(`validates the ${directory} pipeline with Collector 0.157.0`, async () => {
      const config = await renderConfig(directory);
      const result = await validate(config, directory !== "base");
      expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    }, 60_000);
  }

  test("applies the privacy processors to every signal", async () => {
    const config = await renderConfig("overlays/remote");
    const parsed = Bun.YAML.parse(config) as {
      processors: Record<
        string,
        { actions?: Array<{ key: string; action: string }>; attributes?: Array<{ key: string; action: string }> }
      >;
      service: {
        pipelines: Record<
          string,
          { processors: string[]; exporters: string[] }
        >;
      };
    };
    for (const signal of ["traces", "metrics", "logs"]) {
      expect(parsed.service.pipelines[signal]?.processors).toEqual([
        "memory_limiter",
        "k8sattributes",
        "resource/privacy",
        "attributes/privacy",
        "batch",
      ]);
      expect(parsed.service.pipelines[signal]?.exporters).toEqual([
        "otlp_http/remote",
      ]);
    }
    expect(parsed.processors["attributes/privacy"]).toBeDefined();
    expect(parsed.processors["resource/privacy"]).toBeDefined();
    const spanForbidden = new Set(
      parsed.processors["attributes/privacy"]?.actions?.map(
        ({ key }) => key,
      ),
    );
    const resourceForbidden = new Set(
      parsed.processors["resource/privacy"]?.attributes?.map(
        ({ key }) => key,
      ),
    );
    for (const key of spanForbidden) {
      expect(resourceForbidden).toContain(key);
    }
  });
});
