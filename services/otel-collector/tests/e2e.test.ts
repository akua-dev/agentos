import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { createOtlpTestSink } from "./otlp-sink.ts";

const repository = new URL("../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const image =
  "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6";

if (process.env.AGENTOS_RUN_OTEL_E2E === "true") {
  test(
    "persists a privacy-filtered batch across remote outage and Collector restart",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "agentos-otel-e2e-"));
      const storage = join(directory, "storage");
      const configPath = join(directory, "collector.yaml");
      const headersPath = join(directory, "headers.yaml");
      const sink = createOtlpTestSink();
      const port = await freePort();
      const name = `agentos-otel-e2e-${crypto.randomUUID().slice(0, 8)}`;
      await mkdir(storage, { mode: 0o777 });
      await chmod(storage, 0o777);
      const rendered = await command([
        "kubectl",
        "kustomize",
        join(
          repository,
          "services",
          "otel-collector",
          "kubernetes",
          "overlays",
          "remote",
        ),
      ]);
      const resources = parseAllDocuments(rendered).map((document) =>
        document.toJS(),
      ) as Array<{
        kind?: string;
        metadata?: { name?: string };
        data?: { "collector.yaml"?: string };
      }>;
      const source = resources.find(
        (resource) =>
          resource.kind === "ConfigMap" &&
          resource.metadata?.name === "agentos-otel-collector",
      )?.data?.["collector.yaml"];
      if (!source) throw new Error("rendered Collector config is missing");
      // This standalone container has no Kubernetes API. Remove only metadata
      // enrichment; the exact privacy, batching, queue, retry and exporter
      // chain remains the rendered production configuration.
      const config = source.replace(
        /^\s+- k8sattributes\s*$/gm,
        "",
      );
      await writeFile(configPath, config, { mode: 0o600 });
      await writeFile(
        headersPath,
        [
          "exporters:",
          "  otlp_http/remote:",
          "    headers:",
          '      x-agentos-test: "bounded"',
          "",
        ].join("\n"),
        { mode: 0o600 },
      );

      let collector: ReturnType<typeof Bun.spawn> | undefined;
      try {
        collector = startCollector({
          configPath,
          headersPath,
          name,
          port,
          remoteEndpoint: sink.remoteEndpoint,
          storage,
        });
        await waitForReceiver(port);
        const response = await fetch(
          `http://127.0.0.1:${port}/v1/traces`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(seedTrace()),
          },
        );
        expect(response.status).toBe(200);
        await waitFor(() =>
          sink.requests.some(
            (request) =>
              request.path === "/v1/traces" && !request.accepted,
          ),
        );

        await stopCollector(name);
        await collector.exited;
        collector = undefined;
        sink.setAvailable(true);
        collector = startCollector({
          configPath,
          headersPath,
          name,
          port,
          remoteEndpoint: sink.remoteEndpoint,
          storage,
        });
        await waitForReceiver(port);
        await waitFor(() =>
          sink.requests.some(
            (request) =>
              request.path === "/v1/traces" &&
              request.accepted &&
              new TextDecoder().decode(request.body).includes(
                "safe.operation",
              ),
          ),
        );
        const accepted = sink.requests.find(
          (request) =>
            request.accepted &&
            new TextDecoder().decode(request.body).includes(
              "safe.operation",
            ),
        );
        const serialized = new TextDecoder().decode(accepted?.body);
        expect(serialized).toContain("agentos.ai.runtime");
        expect(serialized).toContain("pi");
        for (const forbidden of [
          "SEED_PROMPT",
          "sk-seeded-secret",
          "provider-account@example.test",
          "raw upstream private error",
        ]) {
          expect(serialized).not.toContain(forbidden);
        }
      } finally {
        await stopCollector(name).catch(() => undefined);
        await collector?.exited;
        sink.stop();
        await rm(directory, { force: true, recursive: true });
      }
    },
    45_000,
  );
} else {
  test.skip(
    "persists a privacy-filtered batch across remote outage and Collector restart",
    () => undefined,
  );
}

function startCollector(options: {
  configPath: string;
  headersPath: string;
  name: string;
  port: number;
  remoteEndpoint: string;
  storage: string;
}) {
  return Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "--name",
      options.name,
      "-p",
      `127.0.0.1:${options.port}:4318`,
      "-e",
      `OTEL_EXPORTER_OTLP_ENDPOINT=${options.remoteEndpoint}`,
      "-e",
      "K8S_NODE_NAME=test-node",
      "-v",
      `${options.configPath}:/etc/otelcol/collector.yaml:ro`,
      "-v",
      `${options.headersPath}:/etc/otelcol-secret/headers.yaml:ro`,
      "-v",
      `${options.storage}:/var/lib/otelcol`,
      image,
      "--config=file:/etc/otelcol/collector.yaml",
      "--config=file:/etc/otelcol-secret/headers.yaml",
    ],
    { stderr: "ignore", stdout: "ignore" },
  );
}

async function stopCollector(name: string) {
  await command(["docker", "stop", "--time", "2", name]);
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("Bun did not allocate a test port");
  return port;
}

async function waitForReceiver(port: number) {
  await waitFor(async () => {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/traces`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"resourceSpans":[]}',
        },
      );
      return response.status === 200;
    } catch {
      return false;
    }
  });
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error("timed out waiting for OTLP condition");
}

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`,
    );
  }
  return stdout;
}

function seedTrace() {
  const attribute = (key: string, value: string) => ({
    key,
    value: { stringValue: value },
  });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attribute("service.name", "agentos-e2e"),
            attribute(
              "provider.account.email",
              "provider-account@example.test",
            ),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "agentos-e2e" },
            spans: [
              {
                traceId: "00000000000000000000000000000001",
                spanId: "0000000000000001",
                name: "safe.operation",
                kind: 1,
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "2000000000",
                attributes: [
                  attribute("agentos.ai.runtime", "pi"),
                  attribute("gen_ai.prompt", "SEED_PROMPT"),
                  attribute("authorization", "Bearer sk-seeded-secret"),
                  attribute(
                    "error.message",
                    "raw upstream private error",
                  ),
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}
