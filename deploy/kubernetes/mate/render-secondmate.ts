#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

type Resource = Record<string, unknown>;

export type RenderSecondMateOptions = {
  agentId: string;
  databaseSecret: string;
  databaseUrl: string;
  handle: string;
  image: string;
  model?: string;
  namespace: string;
  output: string;
  storage?: string;
  thinking?: string;
  version: string;
};

export async function renderSecondMate(options: RenderSecondMateOptions) {
  const configuration = validate(options);
  const resources = buildResources(configuration);
  const rendered = serializeResources(resources);
  await mkdir(dirname(configuration.output), { recursive: true });
  await writeFile(configuration.output, rendered, "utf8");
  return resources;
}

function buildResources(options: Required<RenderSecondMateOptions>): Resource[] {
  const resourceName = `agentos-${options.handle}`;
  const session = resourceName;
  const labels = {
    "agentos.akua.dev/agent": options.handle,
    "app.kubernetes.io/name": resourceName,
    "app.kubernetes.io/part-of": "agentos",
    "app.kubernetes.io/version": options.version,
  };
  const environment = [
    { name: "HOME", value: "/home/agent" },
    { name: "AGENTOS_RELEASE_ROOT", value: "/opt/agentos" },
    { name: "AGENTOS_AGENT_CWD", value: "/opt/agentos/agents/secondmate" },
    { name: "AGENTOS_AGENT_ID", value: options.agentId },
    { name: "AGENTOS_AGENT_NAME", value: options.handle },
    { name: "AGENTOS_AGENT_ROLE", value: "second_mate" },
    { name: "AGENTOS_DATABASE_URL", value: options.databaseUrl },
    { name: "AGENTOS_MODEL", value: options.model },
    {
      name: "AGENTOS_PGPASS_SOURCE",
      value: "/var/run/secrets/agentos/pgpass",
    },
    { name: "AGENTOS_THINKING", value: options.thinking },
    { name: "HERDR_CONFIG_PATH", value: "/home/agent/.config/herdr/config.toml" },
    { name: "HERDR_SESSION", value: session },
    { name: "MISE_SYSTEM_CONFIG_FILE", value: "/etc/mise/config.toml" },
    { name: "MISE_GITHUB_GITHUB_ATTESTATIONS", value: "false" },
    { name: "MISE_GITHUB_SLSA", value: "false" },
    { name: "MISE_TRUSTED_CONFIG_PATHS", value: "/opt/agentos" },
    { name: "PGPASSFILE", value: "/home/agent/.pgpass" },
    { name: "PI_CODING_AGENT_DIR", value: "/home/agent/.pi/agent" },
    { name: "PI_OAUTH_CALLBACK_HOST", value: "0.0.0.0" },
    {
      name: "PATH",
      value:
        "/home/agent/.local/share/mise/shims:/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin",
    },
  ];
  const securityContext = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
  };
  const homeVolumeMount = { mountPath: "/home/agent", name: "home" };

  return [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { labels, name: resourceName, namespace: options.namespace },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { labels, name: resourceName, namespace: options.namespace },
      spec: {
        clusterIP: "None",
        selector: { "app.kubernetes.io/name": resourceName },
      },
    },
    {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      metadata: { labels, name: resourceName, namespace: options.namespace },
      spec: {
        replicas: 1,
        serviceName: resourceName,
        persistentVolumeClaimRetentionPolicy: {
          whenDeleted: "Retain",
          whenScaled: "Retain",
        },
        selector: {
          matchLabels: { "app.kubernetes.io/name": resourceName },
        },
        template: {
          metadata: {
            annotations: {
              "agentos.akua.dev/container": "secondmate",
              "agentos.akua.dev/herdr-session": session,
            },
            labels,
          },
          spec: {
            serviceAccountName: resourceName,
            terminationGracePeriodSeconds: 30,
            securityContext: {
              fsGroup: 1000,
              fsGroupChangePolicy: "OnRootMismatch",
              runAsGroup: 1000,
              runAsNonRoot: true,
              runAsUser: 1000,
              seccompProfile: { type: "RuntimeDefault" },
            },
            initContainers: [
              {
                name: "install-tools",
                image: options.image,
                imagePullPolicy: "IfNotPresent",
                workingDir: "/opt/agentos/agents/secondmate",
                command: ["mise"],
                args: [
                  "install",
                  "--locked",
                  "node",
                  "github:oven-sh/bun",
                  "kubectl",
                  "github:ogulcancelik/herdr",
                  "npm:@earendil-works/pi-coding-agent",
                ],
                env: environment,
                securityContext,
                volumeMounts: [homeVolumeMount],
              },
              {
                name: "prepare-home",
                image: options.image,
                imagePullPolicy: "IfNotPresent",
                workingDir: "/opt/agentos/agents/secondmate",
                command: ["mise"],
                args: ["run", "--skip-tools", "secondmate:prepare"],
                env: environment,
                securityContext,
                volumeMounts: [
                  homeVolumeMount,
                  {
                    mountPath: "/var/run/secrets/agentos",
                    name: "database-credentials",
                    readOnly: true,
                  },
                ],
              },
            ],
            containers: [
              {
                name: "secondmate",
                image: options.image,
                imagePullPolicy: "IfNotPresent",
                workingDir: "/opt/agentos/agents/secondmate",
                command: ["mise"],
                args: ["run", "--skip-tools", "secondmate:run"],
                env: environment,
                securityContext,
                volumeMounts: [homeVolumeMount],
                livenessProbe: {
                  exec: {
                    command: [
                      "mise",
                      "run",
                      "--skip-tools",
                      "secondmate:health",
                      "--",
                      "live",
                    ],
                  },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                  timeoutSeconds: 3,
                  failureThreshold: 3,
                },
                readinessProbe: {
                  exec: {
                    command: [
                      "mise",
                      "run",
                      "--skip-tools",
                      "secondmate:health",
                      "--",
                      "ready",
                    ],
                  },
                  initialDelaySeconds: 2,
                  periodSeconds: 5,
                  timeoutSeconds: 3,
                  failureThreshold: 3,
                },
              },
            ],
            volumes: [
              {
                name: "database-credentials",
                secret: { secretName: options.databaseSecret },
              },
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: "home" },
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: { requests: { storage: options.storage } },
            },
          },
        ],
      },
    },
  ];
}

function validate(
  options: RenderSecondMateOptions,
): Required<RenderSecondMateOptions> {
  if (!isHandle(options.handle)) {
    throw new Error(
      "Second Mate handle must be a Kubernetes-safe name of at most 55 characters.",
    );
  }
  assertDnsLabel(options.namespace, "Namespace");
  assertDnsSubdomain(options.databaseSecret, "Database Secret");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      options.agentId,
    )
  ) {
    throw new Error("Agent ID must be a UUID.");
  }
  if (
    !/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(
      options.image,
    )
  ) {
    throw new Error("Mate image must use an immutable sha256 digest.");
  }
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)
  ) {
    throw new Error(
      "Release version must be semantic version text without a v prefix.",
    );
  }

  const databaseUrl = new URL(options.databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !databaseUrl.hostname
  ) {
    throw new Error("Database URL must identify a PostgreSQL host.");
  }
  const hasPasswordParameter = [...databaseUrl.searchParams.keys()].some(
    (name) => name.toLowerCase() === "password",
  );
  if (databaseUrl.password || hasPasswordParameter) {
    throw new Error(
      "Database URL must not contain a password; use the pgpass Secret.",
    );
  }
  if (!databaseUrl.username) {
    throw new Error("Database URL must identify the Agent login.");
  }

  const model = options.model ?? "openai-codex/gpt-5.6-terra";
  if (!/^[^/\s]+\/[^/\s]+$/.test(model)) {
    throw new Error("Model must use provider/model syntax.");
  }
  const thinking = options.thinking ?? "high";
  if (!/^(off|minimal|low|medium|high|xhigh|max)$/.test(thinking)) {
    throw new Error("Thinking must be a Pi thinking level.");
  }
  const storage = options.storage ?? "20Gi";
  if (!/^[1-9][0-9]*(?:Ki|Mi|Gi|Ti)$/.test(storage)) {
    throw new Error("Storage must be a positive binary Kubernetes quantity.");
  }

  return { ...options, model, storage, thinking };
}

function isHandle(value: string): boolean {
  return (
    value.length <= 55 &&
    /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)
  );
}

function assertDnsLabel(value: string, field: string) {
  if (
    value.length > 63 ||
    !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)
  ) {
    throw new Error(`${field} must be a Kubernetes DNS label.`);
  }
}

function assertDnsSubdomain(value: string, field: string) {
  if (value.length > 253 || value.split(".").some((part) => !isDnsLabel(part))) {
    throw new Error(`${field} must be a Kubernetes DNS subdomain.`);
  }
}

function isDnsLabel(value: string): boolean {
  return (
    value.length <= 63 &&
    /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)
  );
}

function serializeResources(resources: Resource[]): string {
  return `${resources
    .map((resource) => JSON.stringify(resource, null, 2))
    .join("\n---\n")}\n`;
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  await renderSecondMate(options);
  console.log(
    JSON.stringify({
      handle: options.handle,
      namespace: options.namespace,
      output: options.output,
    }),
  );
}

function parseArguments(arguments_: string[]): RenderSecondMateOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || !value) usage();
    values.set(name.slice(2), value);
  }
  const required = [
    "agent-id",
    "database-secret",
    "database-url",
    "handle",
    "image",
    "namespace",
    "output",
    "version",
  ];
  if (required.some((name) => !values.get(name))) usage();
  const known = new Set([...required, "model", "storage", "thinking"]);
  if ([...values.keys()].some((name) => !known.has(name))) usage();

  return {
    agentId: values.get("agent-id")!,
    databaseSecret: values.get("database-secret")!,
    databaseUrl: values.get("database-url")!,
    handle: values.get("handle")!,
    image: values.get("image")!,
    model: values.get("model"),
    namespace: values.get("namespace")!,
    output: values.get("output")!,
    storage: values.get("storage"),
    thinking: values.get("thinking"),
    version: values.get("version")!,
  };
}

function usage(): never {
  console.error(
    "Usage: render-secondmate.ts --handle <name> --agent-id <uuid> --image <name@sha256:digest> --version <semver> --namespace <name> --database-url <url-without-password> --database-secret <name> --output <file> [--model <provider/model>] [--thinking <level>] [--storage <quantity>]",
  );
  process.exit(2);
}
