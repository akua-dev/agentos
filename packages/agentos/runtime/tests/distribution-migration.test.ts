import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { migratePiSessionCwd } from "../pi-session.ts";

type Resource = {
  kind: string;
  metadata: {
    annotations?: Record<string, string>;
    name: string;
  };
  roleRef?: Record<string, unknown>;
  spec?: Record<string, any>;
};

const repository = new URL("../../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const firstMateWithDatabase = join(
  repository,
  "packages",
  "agentos",
  "resources",
  "roles",
  "firstmate",
  "kubernetes",
  "tests",
  "fixtures",
  "cloudnative-pg",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function sessionHeader(cwd: string) {
  return {
    cwd,
    id: "session-persistent",
    parentSession: null,
    timestamp: "2026-07-29T00:00:00.000Z",
    type: "session",
    version: 3,
  };
}

async function readSession(path: string) {
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  return {
    header: JSON.parse(lines[0]!),
    history: lines.slice(1).map((line) => JSON.parse(line)),
  };
}

async function renderRollout(
  image: string,
  distributionRoot: string,
): Promise<Resource[]> {
  const overlay = await mkdtemp(
    join(repository, ".agentos-distribution-migration-"),
  );
  temporaryDirectories.push(overlay);
  const roleDirectory = `${distributionRoot}/resources/roles/firstmate`;
  const resourcePath = relative(overlay, firstMateWithDatabase);
  const [newName, digest] = image.split("@");
  await writeFile(
    join(overlay, "kustomization.yaml"),
    `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ${resourcePath}
images:
  - name: agentos
    newName: ${newName}
    digest: ${digest}
patches:
  - target:
      group: apps
      version: v1
      kind: StatefulSet
      name: agentos-firstmate
    patch: |-
      apiVersion: apps/v1
      kind: StatefulSet
      metadata:
        name: agentos-firstmate
      spec:
        template:
          spec:
            initContainers:
              - name: install-tools
                workingDir: ${roleDirectory}
                env:
                  - name: AGENTOS_AGENT_CWD
                    value: ${roleDirectory}
                  - name: AGENTOS_DISTRIBUTION_ROOT
                    value: ${distributionRoot}
              - name: prepare-home
                workingDir: ${roleDirectory}
                env:
                  - name: AGENTOS_AGENT_CWD
                    value: ${roleDirectory}
                  - name: AGENTOS_DISTRIBUTION_ROOT
                    value: ${distributionRoot}
            containers:
              - name: agentos
                workingDir: ${roleDirectory}
                env:
                  - name: AGENTOS_AGENT_CWD
                    value: ${roleDirectory}
                  - name: AGENTOS_DISTRIBUTION_ROOT
                    value: ${distributionRoot}
`,
    "utf8",
  );
  const child = Bun.spawn(
    [
      "kubectl",
      "kustomize",
      "--load-restrictor",
      "LoadRestrictionsNone",
      overlay,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  return Bun.YAML.parse(stdout) as Resource[];
}

function resource(
  resources: Resource[],
  kind: string,
  name: string,
): Resource {
  const match = resources.find(
    (candidate) =>
      candidate.kind === kind && candidate.metadata.name === name,
  );
  if (!match) throw new Error(`Missing ${kind}/${name}`);
  return match;
}

function environment(container: Record<string, any>): Record<string, string> {
  return Object.fromEntries(
    container.env.map(
      ({ name, value }: { name: string; value: string }) => [name, value],
    ),
  );
}

describe("persistent Mate distribution migration", () => {
  test("preserves the retained home while moving one Pi session across distributions and rollback", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agentos-retained-home-"));
    temporaryDirectories.push(sandbox);
    const home = join(sandbox, "home");
    const checkout = join(home, "projects", "agentos");
    const piDirectory = join(home, ".pi", "agent");
    const memoryDirectory = join(home, "memory");
    const herdrDirectory = join(home, ".local", "state", "herdr");
    await Promise.all([
      mkdir(piDirectory, { recursive: true }),
      mkdir(memoryDirectory, { recursive: true }),
      mkdir(herdrDirectory, { recursive: true }),
      mkdir(checkout, { recursive: true }),
    ]);

    const oldRole = join(checkout, "agents", "firstmate");
    const defaultRole = join(
      checkout,
      "packages",
      "default",
      "resources",
      "roles",
      "firstmate",
    );
    const customDistribution = join(checkout, "packages", "acme-agentos");
    const customRole = join(
      customDistribution,
      "resources",
      "roles",
      "firstmate",
    );
    const session = join(piDirectory, "session.jsonl");
    const retained = {
      auth: join(piDirectory, "auth.json"),
      settings: join(piDirectory, "settings.json"),
      memory: join(memoryDirectory, "MEMORY.md"),
      git: join(checkout, ".unfinished-work"),
      herdr: join(herdrDirectory, "agentos-firstmate.json"),
    };
    const history = [
      { message: { content: "preserve conversation", role: "user" }, type: "message" },
      { customType: "agentos-memory-context", type: "custom" },
    ];
    await Promise.all([
      writeFile(
        session,
        [
          JSON.stringify(sessionHeader(oldRole)),
          ...history.map((entry) => JSON.stringify(entry)),
          "",
        ].join("\n"),
        "utf8",
      ),
      writeFile(retained.auth, '{"provider":"preserved"}\n', "utf8"),
      writeFile(
        retained.settings,
        '{"theme":"preserved","defaultModel":"gpt-5.6-sol"}\n',
        "utf8",
      ),
      writeFile(retained.memory, "# Memory index\n- preserve this\n", "utf8"),
      writeFile(retained.git, "unfinished work\n", "utf8"),
      writeFile(
        retained.herdr,
        '{"agent":"firstmate","session":"session-persistent"}\n',
        "utf8",
      ),
    ]);
    const retainedBefore = Object.fromEntries(
      await Promise.all(
        Object.entries(retained).map(async ([name, path]) => [
          name,
          await readFile(path, "utf8"),
        ]),
      ),
    );

    for (const cwd of [
      defaultRole,
      customRole,
      defaultRole,
      oldRole,
    ]) {
      await migratePiSessionCwd(session, cwd);
      const observed = await readSession(session);
      expect(observed.header).toEqual(sessionHeader(cwd));
      expect(observed.history).toEqual(history);
    }

    const retainedAfter = Object.fromEntries(
      await Promise.all(
        Object.entries(retained).map(async ([name, path]) => [
          name,
          await readFile(path, "utf8"),
        ]),
      ),
    );
    expect(retainedAfter).toEqual(retainedBefore);
  });

  test("rewrites only the Pi header cwd after a tolerated malformed preamble", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agentos-session-preamble-"));
    temporaryDirectories.push(sandbox);
    const session = join(sandbox, "session.jsonl");
    const previousCwd = join(sandbox, "previous");
    const nextCwd = join(sandbox, "next");
    const preamble = "\n{malformed\n";
    const history = `${JSON.stringify({
      message: { content: "preserve conversation", role: "user" },
      type: "message",
    })}\n`;
    await writeFile(
      session,
      `${preamble}${JSON.stringify(sessionHeader(previousCwd))}\n${history}`,
      "utf8",
    );

    await migratePiSessionCwd(session, nextCwd);

    expect(await readFile(session, "utf8")).toBe(
      `${preamble}${JSON.stringify(sessionHeader(nextCwd))}\n${history}`,
    );
  });

  test("keeps Pi-only selection separate from native rollout and restores native authorities", async () => {
    const previousImage =
      "ghcr.io/example/agentos@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const customImage =
      "ghcr.io/example/acme-agentos@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const defaultRoot =
      "/home/agent/projects/agentos/packages/agentos";
    const customRoot =
      "/home/agent/projects/agentos/packages/acme-agentos";
    const piOnlySelection = {
      packages: [
        {
          source: "@akua-dev/agentos@0.1.0",
          autoload: false,
          extensions: [],
          skills: ["skills/agentos-supervision"],
        },
        "@example/agentos-replacement@1.0.0",
      ],
    };

    const before = await renderRollout(previousImage, defaultRoot);
    expect(piOnlySelection.packages).toHaveLength(2);
    expect(
      environment(
        resource(before, "StatefulSet", "agentos-firstmate").spec!.template
          .spec.containers[0],
      ).AGENTOS_DISTRIBUTION_ROOT,
    ).toBe(defaultRoot);

    const changed = await renderRollout(customImage, customRoot);
    const rolledBack = await renderRollout(previousImage, defaultRoot);
    const beforeStatefulSet = resource(
      before,
      "StatefulSet",
      "agentos-firstmate",
    );
    const changedStatefulSet = resource(
      changed,
      "StatefulSet",
      "agentos-firstmate",
    );
    const rollbackStatefulSet = resource(
      rolledBack,
      "StatefulSet",
      "agentos-firstmate",
    );
    const beforePod = beforeStatefulSet.spec!.template.spec;
    const changedPod = changedStatefulSet.spec!.template.spec;
    const rollbackPod = rollbackStatefulSet.spec!.template.spec;

    expect(changedPod.containers[0].image).toBe(customImage);
    expect(
      environment(changedPod.containers[0]).AGENTOS_DISTRIBUTION_ROOT,
    ).toBe(customRoot);
    expect(rollbackPod.containers[0].image).toBe(previousImage);
    expect(
      environment(rollbackPod.containers[0]).AGENTOS_DISTRIBUTION_ROOT,
    ).toBe(defaultRoot);

    expect(rollbackStatefulSet.metadata.name).toBe(
      beforeStatefulSet.metadata.name,
    );
    expect(rollbackStatefulSet.spec!.serviceName).toBe(
      beforeStatefulSet.spec!.serviceName,
    );
    expect(rollbackStatefulSet.spec!.volumeClaimTemplates).toEqual(
      beforeStatefulSet.spec!.volumeClaimTemplates,
    );
    expect(rollbackPod.serviceAccountName).toBe(beforePod.serviceAccountName);
    expect(rollbackStatefulSet.spec!.template.metadata.annotations).toEqual(
      beforeStatefulSet.spec!.template.metadata.annotations,
    );
    expect(
      environment(rollbackPod.containers[0]).AGENTOS_DATABASE_URL,
    ).toBe(environment(beforePod.containers[0]).AGENTOS_DATABASE_URL);
    expect(resource(rolledBack, "RoleBinding", "agentos-firstmate-admin")).toEqual(
      resource(before, "RoleBinding", "agentos-firstmate-admin"),
    );
    expect(
      resource(rolledBack, "ServiceAccount", "agentos-firstmate"),
    ).toEqual(resource(before, "ServiceAccount", "agentos-firstmate"));
    expect(
      rolledBack.some(({ kind }) => kind === "Cluster"),
    ).toBeFalse();
  });
});
