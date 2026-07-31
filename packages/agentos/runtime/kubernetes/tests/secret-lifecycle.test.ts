import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const context = process.env.AGENTOS_KUBERNETES_TEST_CONTEXT;
const lifecycleTest = context ? test : test.skip;
const fixture = join(
  new URL(".", import.meta.url).pathname,
  "fixtures",
  "secret-projection",
  "pods.yaml",
);
const secretName = "managed-credential";
const expectedLabels = {
  "agentos.akua.dev/secret-owner": "test-service",
  "agentos.akua.dev/secret-schema": "token-version-v1",
  "agentos.akua.dev/secret-scope": "disposable-proof",
  "app.kubernetes.io/managed-by": "agentos",
};

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type SecretSnapshot = {
  annotations: string[];
  dataKeys: string[];
  labels: Record<string, string>;
  resourceVersion: string;
  type: string;
  uid: string;
};

const capturedOutput: string[] = [];

async function kubectl(
  namespace: string,
  args: string[],
): Promise<CommandResult> {
  if (!context) throw new Error("Missing disposable Kubernetes context");
  const child = Bun.spawn(
    [
      "kubectl",
      "--context",
      context,
      ...(namespace ? ["--namespace", namespace] : []),
      ...args,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  capturedOutput.push(stdout, stderr);
  return { exitCode, stderr, stdout };
}

async function requireKubectl(
  namespace: string,
  args: string[],
): Promise<string> {
  const result = await kubectl(namespace, args);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout.trim();
}

async function writeManagedSecret(
  namespace: string,
  operation: "create" | "replace",
  tokenFile: string,
  versionFile: string,
  resourceVersion = "",
): Promise<CommandResult> {
  if (!context) throw new Error("Missing disposable Kubernetes context");
  const render = Bun.spawn(
    [
      "kubectl",
      "--context",
      context,
      "--namespace",
      namespace,
      "create",
      "secret",
      "generic",
      secretName,
      `--from-file=token=${tokenFile}`,
      `--from-file=version=${versionFile}`,
      "--dry-run=client",
      "--output=json",
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const normalize = Bun.spawn(
    [
      "jq",
      "--compact-output",
      "--arg",
      "resourceVersion",
      resourceVersion,
      "--arg",
      "owner",
      expectedLabels["agentos.akua.dev/secret-owner"],
      "--arg",
      "scope",
      expectedLabels["agentos.akua.dev/secret-scope"],
      "--arg",
      "schema",
      expectedLabels["agentos.akua.dev/secret-schema"],
      `
        if $resourceVersion == "" then
          del(.metadata.resourceVersion)
        else
          .metadata.resourceVersion = $resourceVersion
        end
        | .metadata.labels = {
            "app.kubernetes.io/managed-by": "agentos",
            "agentos.akua.dev/secret-owner": $owner,
            "agentos.akua.dev/secret-scope": $scope,
            "agentos.akua.dev/secret-schema": $schema
          }
        | del(.metadata.annotations, .metadata.creationTimestamp)
      `,
    ],
    { stdin: render.stdout, stderr: "pipe", stdout: "pipe" },
  );
  const submit = Bun.spawn(
    [
      "kubectl",
      "--context",
      context,
      "--namespace",
      namespace,
      operation,
      "--filename=-",
      "--output=name",
    ],
    { stdin: normalize.stdout, stderr: "pipe", stdout: "pipe" },
  );
  const [
    renderExitCode,
    normalizeExitCode,
    exitCode,
    renderStderr,
    normalizeStderr,
    stdout,
    stderr,
  ] = await Promise.all([
    render.exited,
    normalize.exited,
    submit.exited,
    new Response(render.stderr).text(),
    new Response(normalize.stderr).text(),
    new Response(submit.stdout).text(),
    new Response(submit.stderr).text(),
  ]);
  capturedOutput.push(renderStderr, normalizeStderr, stdout, stderr);
  expect(renderExitCode).toBe(0);
  expect(normalizeExitCode).toBe(0);
  return { exitCode, stderr, stdout };
}

function lines(value: string): string[] {
  return value
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

async function inspectSecret(namespace: string): Promise<SecretSnapshot> {
  const query = (template: string) =>
    requireKubectl(namespace, [
      "get",
      `secret/${secretName}`,
      "--output",
      template,
    ]);
  const [uid, resourceVersion, type, annotations, dataKeys, ...labels] =
    await Promise.all([
      query("jsonpath={.metadata.uid}"),
      query("jsonpath={.metadata.resourceVersion}"),
      query("jsonpath={.type}"),
      query(
        "go-template={{range $key, $_ := .metadata.annotations}}{{println $key}}{{end}}",
      ),
      query(
        "go-template={{range $key, $_ := .data}}{{println $key}}{{end}}",
      ),
      ...Object.keys(expectedLabels).map((key) =>
        query(`go-template={{index .metadata.labels ${JSON.stringify(key)}}}`),
      ),
    ]);
  return {
    annotations: lines(annotations),
    dataKeys: lines(dataKeys),
    labels: Object.fromEntries(
      Object.keys(expectedLabels).map((key, index) => [key, labels[index]!]),
    ),
    resourceVersion,
    type,
    uid,
  };
}

function validateManagedContract(
  snapshot: SecretSnapshot,
  allowAnnotations = false,
): void {
  if (snapshot.type !== "Opaque") throw new Error("unexpected Secret type");
  if (JSON.stringify(snapshot.labels) !== JSON.stringify(expectedLabels)) {
    throw new Error("conflicting Secret ownership, scope, or schema");
  }
  if (JSON.stringify(snapshot.dataKeys) !== JSON.stringify(["token", "version"])) {
    throw new Error("unexpected Secret data keys");
  }
  if (!allowAnnotations && snapshot.annotations.length > 0) {
    throw new Error("managed Secret has annotations");
  }
}

async function waitForProjectedVersion(
  namespace: string,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await kubectl(namespace, [
      "exec",
      "pod/secret-reader",
      "--container=reader",
      "--",
      "cat",
      "/var/run/secrets/agentos/version",
    ]);
    if (result.exitCode === 0 && result.stdout.trim() === expected) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`Projected Secret did not reach ${expected}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

lifecycleTest(
  "proves managed Secret retry, rotation, conflict, takeover, projection, rollback, and revocation",
  async () => {
    if (!context) throw new Error("Missing disposable Kubernetes context");
    capturedOutput.length = 0;
    const namespace = `agentos-secret-proof-${randomBytes(3).toString("hex")}`;
    const staging = await mkdtemp(join(tmpdir(), "agentos-secret-proof-"));
    const originalToken = randomBytes(32).toString("base64url");
    const rotatedToken = randomBytes(32).toString("base64url");
    const originalTokenFile = join(staging, "original-token");
    const rotatedTokenFile = join(staging, "rotated-token");
    const versionOneFile = join(staging, "version-one");
    const versionTwoFile = join(staging, "version-two");

    try {
      await chmod(staging, 0o700);
      expect((await stat(staging)).mode & 0o777).toBe(0o700);
      await Promise.all([
        writeFile(originalTokenFile, originalToken, { mode: 0o600 }),
        writeFile(rotatedTokenFile, rotatedToken, { mode: 0o600 }),
        writeFile(versionOneFile, "v1", { mode: 0o600 }),
        writeFile(versionTwoFile, "v2", { mode: 0o600 }),
      ]);
      for (const file of [
        originalTokenFile,
        rotatedTokenFile,
        versionOneFile,
        versionTwoFile,
      ]) {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }

      await requireKubectl("", ["create", "namespace", namespace]);
      await requireKubectl("", [
        "label",
        `namespace/${namespace}`,
        "pod-security.kubernetes.io/enforce=restricted",
        "pod-security.kubernetes.io/enforce-version=latest",
      ]);

      const created = await writeManagedSecret(
        namespace,
        "create",
        originalTokenFile,
        versionOneFile,
      );
      expect(created).toEqual({
        exitCode: 0,
        stderr: "",
        stdout: `secret/${secretName}\n`,
      });
      const initial = await inspectSecret(namespace);
      validateManagedContract(initial);
      expect(() =>
        validateManagedContract({
          ...initial,
          dataKeys: ["token", "unexpected", "version"],
        }),
      ).toThrow("unexpected Secret data keys");

      const exactRetry = await writeManagedSecret(
        namespace,
        "replace",
        originalTokenFile,
        versionOneFile,
        initial.resourceVersion,
      );
      expect(exactRetry.exitCode).toBe(0);
      const retried = await inspectSecret(namespace);
      validateManagedContract(retried);
      expect(retried.uid).toBe(initial.uid);

      await requireKubectl(namespace, ["create", "--filename", fixture]);
      await requireKubectl(namespace, [
        "wait",
        "--for=condition=Ready",
        "pod/secret-reader",
        "pod/unrelated-reader",
        "--timeout=180s",
      ]);
      expect(
        await requireKubectl(namespace, [
          "exec",
          "pod/secret-reader",
          "--container=reader",
          "--",
          "stat",
          "-L",
          "-c",
          "%a:%u:%g",
          "/var/run/secrets/agentos/token",
        ]),
      ).toBe("440:0:2000");
      await requireKubectl(namespace, [
        "exec",
        "pod/secret-reader",
        "--container=reader",
        "--",
        "sh",
        "-c",
        "test -r /var/run/secrets/agentos/token",
      ]);
      await requireKubectl(namespace, [
        "exec",
        "pod/unrelated-reader",
        "--container=reader",
        "--",
        "sh",
        "-c",
        "test ! -r /var/run/secrets/agentos/token",
      ]);
      await waitForProjectedVersion(namespace, "v1");

      await requireKubectl(namespace, [
        "annotate",
        `secret/${secretName}`,
        "agentos.akua.dev/test-conflict=concurrent-writer",
      ]);
      await requireKubectl(namespace, [
        "annotate",
        `secret/${secretName}`,
        "agentos.akua.dev/test-conflict-",
      ]);
      const afterConcurrentWrite = await inspectSecret(namespace);
      validateManagedContract(afterConcurrentWrite);
      expect(afterConcurrentWrite.resourceVersion).not.toBe(
        retried.resourceVersion,
      );

      const staleReplacement = await writeManagedSecret(
        namespace,
        "replace",
        rotatedTokenFile,
        versionTwoFile,
        retried.resourceVersion,
      );
      expect(staleReplacement.exitCode).not.toBe(0);
      expect(staleReplacement.stderr).toContain("the object has been modified");

      const rotated = await writeManagedSecret(
        namespace,
        "replace",
        rotatedTokenFile,
        versionTwoFile,
        afterConcurrentWrite.resourceVersion,
      );
      expect(rotated.exitCode).toBe(0);
      const afterRotation = await inspectSecret(namespace);
      validateManagedContract(afterRotation);
      expect(afterRotation.uid).toBe(initial.uid);
      await waitForProjectedVersion(namespace, "v2");

      const rolledBack = await writeManagedSecret(
        namespace,
        "replace",
        originalTokenFile,
        versionOneFile,
        afterRotation.resourceVersion,
      );
      expect(rolledBack.exitCode).toBe(0);
      const afterRollback = await inspectSecret(namespace);
      validateManagedContract(afterRollback);
      expect(afterRollback.uid).toBe(initial.uid);
      await waitForProjectedVersion(namespace, "v1");

      await requireKubectl(namespace, [
        "annotate",
        `secret/${secretName}`,
        "kubectl.kubernetes.io/last-applied-configuration=synthetic-legacy-value",
      ]);
      const annotated = await inspectSecret(namespace);
      expect(() => validateManagedContract(annotated)).toThrow(
        "managed Secret has annotations",
      );
      await requireKubectl(namespace, [
        "label",
        `secret/${secretName}`,
        "agentos.akua.dev/secret-scope=conflicting-scope",
        "--overwrite",
      ]);
      const conflict = await inspectSecret(namespace);
      expect(() => validateManagedContract(conflict)).toThrow(
        "conflicting Secret ownership, scope, or schema",
      );
      expect(conflict.annotations).toEqual([
        "kubectl.kubernetes.io/last-applied-configuration",
      ]);

      validateManagedContract(
        { ...conflict, labels: expectedLabels },
        true,
      );
      const takeover = await writeManagedSecret(
        namespace,
        "replace",
        rotatedTokenFile,
        versionTwoFile,
        conflict.resourceVersion,
      );
      expect(takeover.exitCode).toBe(0);
      const afterTakeover = await inspectSecret(namespace);
      validateManagedContract(afterTakeover);
      expect(afterTakeover.uid).toBe(initial.uid);
      expect(afterTakeover.annotations).toEqual([]);
      await waitForProjectedVersion(namespace, "v2");

      for (const pod of ["secret-reader", "unrelated-reader"]) {
        expect(await requireKubectl(namespace, ["logs", `pod/${pod}`])).toBe("");
      }
      const output = capturedOutput.join("\n");
      for (const credential of [originalToken, rotatedToken]) {
        expect(output).not.toContain(credential);
        expect(output).not.toContain(
          Buffer.from(credential, "utf8").toString("base64"),
        );
      }

      await requireKubectl(namespace, [
        "delete",
        "pod/secret-reader",
        "pod/unrelated-reader",
        "--wait=true",
      ]);
      expect(
        await requireKubectl(namespace, [
          "get",
          `secret/${secretName}`,
          "--output=jsonpath={.metadata.uid}",
        ]),
      ).toBe(initial.uid);
      await requireKubectl(namespace, [
        "delete",
        `secret/${secretName}`,
        "--wait=true",
      ]);
      expect(
        await requireKubectl(namespace, [
          "get",
          `secret/${secretName}`,
          "--ignore-not-found",
          "--output=name",
        ]),
      ).toBe("");

      await rm(staging, { force: true, recursive: true });
      expect(await pathExists(staging)).toBe(false);
    } finally {
      await kubectl("", [
        "delete",
        `namespace/${namespace}`,
        "--ignore-not-found=true",
        "--wait=true",
      ]);
      await rm(staging, { force: true, recursive: true });
    }
  },
  420_000,
);
