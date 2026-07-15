import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSecondMate } from "../render-secondmate.ts";

type Resource = {
  apiVersion: string;
  kind: string;
  metadata: {
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    name: string;
    namespace?: string;
  };
  spec?: Record<string, any>;
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Second Mate manifest renderer", () => {
  test("renders one isolated persistent Mate from explicit inputs", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agentos-secondmate-render-"));
    temporaryDirectories.push(sandbox);
    const firstOutput = join(sandbox, "delivery-second.yaml");
    const secondOutput = join(sandbox, "delivery-second-copy.yaml");
    const options = {
      agentId: "20000000-0000-4000-8000-000000000002",
      databaseSecret: "delivery-second-postgres",
      databaseUrl:
        "postgresql://runtime_delivery_second@agentos-postgres-rw.agentos.svc:5432/agentos",
      handle: "delivery-second",
      image:
        "ghcr.io/akua-dev/agentos@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      model: "openai-codex/gpt-5.6-terra",
      namespace: "agentos",
      output: firstOutput,
      storage: "20Gi",
      thinking: "high",
      version: "0.1.0",
    };

    await renderSecondMate(options);
    await renderSecondMate({ ...options, output: secondOutput });

    const rendered = await readFile(firstOutput, "utf8");
    expect(await readFile(secondOutput, "utf8")).toBe(rendered);
    const resources = Bun.YAML.parse(rendered) as Resource[];
    expect(resources.map(({ kind, metadata }) => `${kind}/${metadata.name}`)).toEqual([
      "ServiceAccount/agentos-delivery-second",
      "Service/agentos-delivery-second",
      "StatefulSet/agentos-delivery-second",
    ]);
    expect(resources.some(({ kind }) => kind === "Secret" || kind.includes("Role"))).toBe(
      false,
    );

    const service = resource(resources, "Service");
    expect(service.spec).toEqual({
      clusterIP: "None",
      selector: { "app.kubernetes.io/name": "agentos-delivery-second" },
    });

    const statefulSet = resource(resources, "StatefulSet");
    expect(statefulSet.metadata.labels?.["app.kubernetes.io/version"]).toBe(
      "0.1.0",
    );
    const spec = statefulSet.spec!;
    expect(spec.persistentVolumeClaimRetentionPolicy).toEqual({
      whenDeleted: "Retain",
      whenScaled: "Retain",
    });
    expect(spec.volumeClaimTemplates).toEqual([
      {
        metadata: { name: "home" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "20Gi" } },
        },
      },
    ]);
    expect(spec.template.metadata.annotations).toEqual({
      "agentos.akua.dev/container": "secondmate",
      "agentos.akua.dev/herdr-session": "agentos-delivery-second",
    });
    expect(spec.template.spec.serviceAccountName).toBe("agentos-delivery-second");

    const pod = spec.template.spec;
    const [install, prepare] = pod.initContainers;
    const [secondMate] = pod.containers;
    for (const container of [install, prepare, secondMate]) {
      expect(container.image).toBe(options.image);
      expect(container.imagePullPolicy).toBe("IfNotPresent");
    }
    expect(prepare.args).toEqual([
      "run",
      "--skip-tools",
      "secondmate:prepare",
    ]);
    expect(secondMate.args).toEqual([
      "run",
      "--skip-tools",
      "secondmate:run",
    ]);
    expect(install.volumeMounts).toEqual([
      { mountPath: "/home/agent", name: "home" },
    ]);
    expect(prepare.volumeMounts).toEqual([
      { mountPath: "/home/agent", name: "home" },
      {
        mountPath: "/var/run/secrets/agentos",
        name: "database-credentials",
        readOnly: true,
      },
    ]);
    expect(secondMate.volumeMounts).toEqual([
      { mountPath: "/home/agent", name: "home" },
    ]);
    expect(pod.volumes).toEqual([
      {
        name: "database-credentials",
        secret: { secretName: "delivery-second-postgres" },
      },
    ]);

    const environment = Object.fromEntries(
      secondMate.env.map(({ name, value }: { name: string; value: string }) => [
        name,
        value,
      ]),
    );
    expect(environment).toMatchObject({
      AGENTOS_AGENT_CWD: "/opt/agentos/agents/secondmate",
      AGENTOS_AGENT_ID: options.agentId,
      AGENTOS_AGENT_NAME: options.handle,
      AGENTOS_AGENT_ROLE: "second_mate",
      AGENTOS_DATABASE_URL: options.databaseUrl,
      AGENTOS_MODEL: options.model,
      AGENTOS_PGPASS_SOURCE: "/var/run/secrets/agentos/pgpass",
      AGENTOS_THINKING: options.thinking,
      HERDR_SESSION: "agentos-delivery-second",
      PGPASSFILE: "/home/agent/.pgpass",
    });
  });

  test("rejects mutable images and credentials embedded in database URLs", async () => {
    const options = {
      agentId: "20000000-0000-4000-8000-000000000002",
      databaseSecret: "delivery-second-postgres",
      databaseUrl: "postgresql://runtime_second@postgres:5432/agentos",
      handle: "delivery-second",
      image:
        "ghcr.io/akua-dev/agentos@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      namespace: "agentos",
      output: "/tmp/unused.yaml",
      version: "0.1.0",
    };

    await expect(
      renderSecondMate({ ...options, image: "ghcr.io/akua-dev/agentos:latest" }),
    ).rejects.toThrow("immutable sha256 digest");
    await expect(
      renderSecondMate({
        ...options,
        databaseUrl: "postgresql://runtime_second:secret@postgres:5432/agentos",
      }),
    ).rejects.toThrow("must not contain a password");
    await expect(
      renderSecondMate({
        ...options,
        databaseUrl:
          "postgresql://runtime_second@postgres:5432/agentos?password=secret",
      }),
    ).rejects.toThrow("must not contain a password");
    await expect(
      renderSecondMate({
        ...options,
        databaseUrl: "postgresql://postgres:5432/agentos",
      }),
    ).rejects.toThrow("must identify the Agent login");
  });
});

function resource(resources: Resource[], kind: string): Resource {
  const found = resources.find((candidate) => candidate.kind === kind);
  if (!found) throw new Error(`Missing ${kind}`);
  return found;
}
