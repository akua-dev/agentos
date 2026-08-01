import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
} from "../../../../../src/access/identity.ts";

const context = process.env.AGENTOS_KUBERNETES_TEST_CONTEXT;
const lifecycleTest = context ? test : test.skip;
const kubernetes = new URL("..", import.meta.url).pathname;
const alpha = "agentos-domain-alpha";
const beta = "agentos-domain-beta";
const core = "agentos";
const secondmateIdentity = `system:serviceaccount:${alpha}:agentos-secondmate`;
const firstmateIdentity = `system:serviceaccount:${core}:agentos-firstmate`;
const clusterScopedResources = new Set([
  "clusterroles.rbac.authorization.k8s.io",
  "namespaces",
  "validatingadmissionpolicies.admissionregistration.k8s.io",
  "validatingadmissionpolicybindings.admissionregistration.k8s.io",
]);

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

async function kubectl(
  args: string[],
  input?: string,
): Promise<CommandResult> {
  if (!context) throw new Error("Missing disposable Kubernetes context");
  const child = Bun.spawn(["kubectl", "--context", context, ...args], {
    stderr: "pipe",
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
  });
  if (input !== undefined) {
    const standardInput = child.stdin;
    if (standardInput === undefined) {
      throw new Error("kubectl stdin was not opened");
    }
    standardInput.write(input);
    standardInput.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function requireKubectl(args: string[]): Promise<string> {
  const result = await kubectl(args);
  expect(result, `kubectl ${args.join(" ")}`).toMatchObject({
    exitCode: 0,
    stderr: "",
  });
  return result.stdout.trim();
}

async function requireAdmissionDenial(
  namespace: string,
  identity: string,
  manifest: unknown,
  message: string,
): Promise<void> {
  const result = await kubectl(
    [
      "--namespace",
      namespace,
      "--as",
      identity,
      "create",
      "--dry-run=server",
      "--filename=-",
    ],
    JSON.stringify(manifest),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function workloadParts(workload: unknown) {
  const root = requireRecord(workload, "workload");
  const metadata = requireRecord(root.metadata, "workload.metadata");
  const specification = requireRecord(root.spec, "workload.spec");
  const template = requireRecord(
    specification.template,
    "workload.spec.template",
  );
  const templateMetadata = requireRecord(
    template.metadata,
    "workload.spec.template.metadata",
  );
  const pod = requireRecord(template.spec, "workload.spec.template.spec");
  const containers = requireArray(
    pod.containers,
    "workload.spec.template.spec.containers",
  );
  return {
    container: requireRecord(
      containers[0],
      "workload.spec.template.spec.containers[0]",
    ),
    labels: requireRecord(metadata.labels, "workload.metadata.labels"),
    pod,
    templateLabels: requireRecord(
      templateMetadata.labels,
      "workload.spec.template.metadata.labels",
    ),
  };
}

function egressTokenProjection(workload: unknown) {
  const pod = workloadParts(workload).pod;
  const volumes = requireArray(
    pod.volumes,
    "workload.spec.template.spec.volumes",
  );
  const identityVolume = volumes.map((volume, index) =>
    requireRecord(volume, `workload.spec.template.spec.volumes[${index}]`)
  ).find((volume) => volume.name === "agentos-egress-identity");
  if (identityVolume === undefined) {
    throw new Error("Workload is missing agentos-egress-identity volume");
  }
  const projected = requireRecord(
    identityVolume.projected,
    "agentos-egress-identity.projected",
  );
  const sources = requireArray(
    projected.sources,
    "agentos-egress-identity.projected.sources",
  );
  expect(sources).toHaveLength(1);
  return requireRecord(
    requireRecord(sources[0], "agentos-egress-identity source")
      .serviceAccountToken,
    "agentos-egress-identity serviceAccountToken",
  );
}

function hasNoTypeCheckingWarnings(status: unknown): boolean {
  if (!isRecord(status)) return false;
  const typeChecking = status.typeChecking;
  if (typeChecking === undefined) return true;
  if (!isRecord(typeChecking)) return false;
  const warnings = typeChecking.expressionWarnings;
  return warnings === undefined || (Array.isArray(warnings) && warnings.length === 0);
}

async function canI(
  identity: string,
  namespace: string,
  verb: string,
  resource: string,
): Promise<boolean> {
  const [baseResource, subresource] = resource.split("/");
  const result = await kubectl([
    "auth",
    "can-i",
    verb,
    baseResource!,
    ...(subresource ? [`--subresource=${subresource}`] : []),
    "--as",
    identity,
    ...(clusterScopedResources.has(baseResource!)
      ? ["--all-namespaces"]
      : ["--namespace", namespace]),
  ]);
  expect([0, 1]).toContain(result.exitCode);
  expect(result.stderr).toBe("");
  const output = result.stdout.trim();
  expect(["yes", "no"]).toContain(output);
  return output === "yes";
}

async function waitForPodUid(
  namespace: string,
  name: string,
  previousUid?: string,
  requireReady = false,
): Promise<string> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await kubectl([
      "--namespace",
      namespace,
      "get",
      `pod/${name}`,
      "--output=jsonpath={.metadata.uid}{\"|\"}{.status.conditions[?(@.type==\"Ready\")].status}",
    ]);
    if (result.exitCode === 0) {
      const [uid, ready] = result.stdout.split("|");
      const isNew = previousUid === undefined || uid !== previousUid;
      if (uid && isNew && (!requireReady || ready === "True")) return uid;
    }
    await Bun.sleep(1_000);
  }
  throw new Error(
    `Pod ${namespace}/${name} did not reach the expected replacement state`,
  );
}

lifecycleTest(
  "proves domain-local child lifecycle, sibling denial, supervision, and PVC retention",
  async () => {
    const alphaFixture = join(kubernetes, "tests", "fixtures", "domain-alpha");
    const betaFixture = join(kubernetes, "tests", "fixtures", "domain-beta");
    const admission = join(kubernetes, "admission");
    const childFixture = join(
      kubernetes,
      "tests",
      "fixtures",
      "lifecycle-child",
    );

    try {
      await requireKubectl(["create", "namespace", core]);
      await requireKubectl([
        "label",
        "namespace",
        core,
        "agentos.akua.dev/fleet=default",
      ]);
      await requireKubectl([
        "--namespace",
        core,
        "create",
        "serviceaccount",
        "agentos-firstmate",
      ]);
      await requireKubectl([
        "apply",
        "--server-side",
        "--kustomize",
        admission,
      ]);
      const admissionPolicies = JSON.parse(
        await requireKubectl([
          "get",
          "validatingadmissionpolicies.admissionregistration.k8s.io",
          "--output=json",
        ]),
      );
      expect(
        admissionPolicies.items.map(
          ({ metadata }: { metadata: { name: string } }) => metadata.name,
        ).sort(),
      ).toEqual([
        "agentos-crewmate-pods",
        "agentos-crewmate-statefulsets",
      ]);
      expect(
        admissionPolicies.items.every(
          ({ status }: { status: unknown }) =>
            hasNoTypeCheckingWarnings(status),
        ),
      ).toBe(true);
      await requireKubectl([
        "apply",
        "--server-side",
        "--kustomize",
        alphaFixture,
      ]);
      await requireKubectl([
        "apply",
        "--server-side",
        "--kustomize",
        betaFixture,
      ]);

      const secondmatePodUid = await waitForPodUid(
        alpha,
        "agentos-secondmate-0",
      );
      const secondmatePvcUid = await requireKubectl([
        "--namespace",
        alpha,
        "get",
        "persistentvolumeclaim/home-agentos-secondmate-0",
        "--output=jsonpath={.metadata.uid}",
      ]);
      const namespace = JSON.parse(
        await requireKubectl(["get", `namespace/${alpha}`, "--output=json"]),
      );
      expect(namespace.metadata.labels).toMatchObject({
        "agentos.akua.dev/owner-agent-id":
          "00000000-0000-4000-8000-00000000000a",
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": "v1.35",
      });
      const secondmateStatefulSet = JSON.parse(
        await requireKubectl([
          "--namespace",
          alpha,
          "get",
          "statefulset/agentos-secondmate",
          "--output=json",
        ]),
      );
      const secondmateEnvironment = Object.fromEntries(
        secondmateStatefulSet.spec.template.spec.containers[0].env.map(
          ({ name, value }: { name: string; value: string }) => [name, value],
        ),
      );
      expect(secondmateEnvironment).toMatchObject({
        AGENTOS_AGENT_ID: "00000000-0000-4000-8000-00000000000a",
        AGENTOS_DATABASE_URL:
          "postgresql://runtime_secondmate@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos?sslmode=require",
        HERDR_SESSION: "agentos-secondmate",
      });

      const renderedChild = Bun.YAML.parse(
        await requireKubectl([
          "kustomize",
          "--load-restrictor",
          "LoadRestrictionsNone",
          childFixture,
        ]),
      );
      const renderedResources = requireArray(renderedChild, "rendered child");
      const validChild = renderedResources.find((resource) => {
        const candidate = requireRecord(resource, "rendered child resource");
        return candidate.kind === "StatefulSet";
      });
      if (validChild === undefined) {
        throw new Error("Rendered child is missing its StatefulSet");
      }

      const mutableImage = structuredClone(validChild);
      workloadParts(mutableImage).container.image =
        "registry.k8s.io/pause:3.10.1";
      await requireAdmissionDenial(
        alpha,
        secondmateIdentity,
        mutableImage,
        "Every Crewmate image must be a remote image pinned by sha256 digest",
      );

      const missingLabels = structuredClone(validChild);
      const missingLabelParts = workloadParts(missingLabels);
      delete missingLabelParts.labels["agentos.akua.dev/task-id"];
      delete missingLabelParts.templateLabels["agentos.akua.dev/task-id"];
      await requireAdmissionDenial(
        alpha,
        secondmateIdentity,
        missingLabels,
        "Crewmates require matching UUID Agent, owner, Task, and Assignment labels",
      );

      const unexpectedToken = structuredClone(validChild);
      workloadParts(unexpectedToken).pod.automountServiceAccountToken = true;
      await requireAdmissionDenial(
        alpha,
        secondmateIdentity,
        unexpectedToken,
        "disabled token automount",
      );

      const widenedAudience = structuredClone(validChild);
      egressTokenProjection(widenedAudience).audience = "kubernetes";
      await requireAdmissionDenial(
        alpha,
        secondmateIdentity,
        widenedAudience,
        "only the dedicated egress identity token projection",
      );

      const widenedLifetime = structuredClone(validChild);
      egressTokenProjection(widenedLifetime).expirationSeconds =
        AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS + 600;
      await requireAdmissionDenial(
        alpha,
        secondmateIdentity,
        widenedLifetime,
        "only the dedicated egress identity token projection",
      );

      const wrongTokenPath = structuredClone(validChild);
      egressTokenProjection(wrongTokenPath).path = "kubernetes-api-token";
      await requireAdmissionDenial(
        alpha,
        secondmateIdentity,
        wrongTokenPath,
        "only the dedicated egress identity token projection",
      );

      expect(egressTokenProjection(validChild)).toEqual({
        audience: AGENTOS_EGRESS_TOKEN_AUDIENCE,
        expirationSeconds: AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
        path: "token",
      });

      const initContainerToken = structuredClone(validChild);
      const initContainerTokenParts = workloadParts(initContainerToken);
      initContainerTokenParts.pod.initContainers = [{
        ...structuredClone(initContainerTokenParts.container),
        name: "identity-reading-init",
      }];
      await requireAdmissionDenial(
        alpha,
        secondmateIdentity,
        initContainerToken,
        "only the dedicated egress identity token projection",
      );

      const hostAccess = structuredClone(validChild);
      workloadParts(hostAccess).pod.hostNetwork = true;
      await requireAdmissionDenial(
        alpha,
        secondmateIdentity,
        hostAccess,
        "cannot use host namespaces",
      );

      const excessiveResources = structuredClone(validChild);
      const excessiveContainer = workloadParts(excessiveResources).container;
      const excessiveResourcesValue = requireRecord(
        excessiveContainer.resources,
        "container.resources",
      );
      requireRecord(excessiveResourcesValue.limits, "container.resources.limits")
        .cpu = "8";
      await requireAdmissionDenial(
        alpha,
        secondmateIdentity,
        excessiveResources,
        "within the domain ceiling",
      );

      const providerRootCredential = structuredClone(validChild);
      const providerRootCredentialContainer = workloadParts(
        providerRootCredential,
      ).container;
      const providerRootCredentialEnv =
        providerRootCredentialContainer.env === undefined
          ? (providerRootCredentialContainer.env = [])
          : requireArray(providerRootCredentialContainer.env, "container.env");
      providerRootCredentialEnv.push({
        name: "OPENAI_API_KEY",
        value: "not-a-real-secret",
      });
      await requireAdmissionDenial(
        alpha,
        secondmateIdentity,
        providerRootCredential,
        "Direct provider-root credential environment variables are not permitted",
      );

      const selfMutation = await kubectl([
        "--namespace",
        alpha,
        "--as",
        secondmateIdentity,
        "patch",
        "statefulset/agentos-secondmate",
        "--dry-run=server",
        "--type=merge",
        "--patch",
        '{"metadata":{"annotations":{"agentos.akua.dev/test":"denied"}}}',
      ]);
      expect(selfMutation.exitCode).toBe(1);
      expect(selfMutation.stderr).toContain(
        "A Second Mate cannot create, update, or delete its persistent Mate workload",
      );

      for (const [verb, resource] of [
        ["create", "statefulsets.apps"],
        ["create", "services"],
        ["create", "serviceaccounts"],
        ["get", "pods"],
        ["delete", "pods"],
        ["create", "pods/exec"],
        ["get", "persistentvolumeclaims"],
      ]) {
        expect(await canI(secondmateIdentity, alpha, verb!, resource!)).toBe(
          true,
        );
      }
      for (const [verb, resource] of [
        ["create", "namespaces"],
        ["create", "clusterroles.rbac.authorization.k8s.io"],
        [
          "create",
          "validatingadmissionpolicies.admissionregistration.k8s.io",
        ],
        [
          "create",
          "validatingadmissionpolicybindings.admissionregistration.k8s.io",
        ],
        ["get", "secrets"],
        ["create", "secrets"],
        ["create", "rolebindings.rbac.authorization.k8s.io"],
        ["create", "networkpolicies.networking.k8s.io"],
        ["update", "resourcequotas"],
        ["update", "limitranges"],
      ]) {
        expect(await canI(secondmateIdentity, alpha, verb!, resource!)).toBe(
          false,
        );
      }
      for (const [verb, resource] of [
        ["get", "pods"],
        ["get", "services"],
        ["create", "statefulsets.apps"],
        ["create", "pods/exec"],
        ["get", "secrets"],
      ]) {
        expect(await canI(secondmateIdentity, beta, verb!, resource!)).toBe(
          false,
        );
      }

      for (const [namespace, verb, resource] of [
        [alpha, "get", "pods"],
        [alpha, "delete", "pods"],
        [alpha, "create", "pods/exec"],
        [alpha, "patch", "statefulsets.apps"],
        [alpha, "create", "secrets"],
        [alpha, "get", "persistentvolumeclaims"],
        [alpha, "update", "roles.rbac.authorization.k8s.io"],
        [alpha, "update", "rolebindings.rbac.authorization.k8s.io"],
        [alpha, "update", "networkpolicies.networking.k8s.io"],
        [alpha, "update", "resourcequotas"],
        [beta, "get", "pods"],
        [beta, "get", "persistentvolumeclaims"],
        [beta, "patch", "statefulsets.apps"],
      ]) {
        expect(await canI(firstmateIdentity, namespace!, verb!, resource!)).toBe(
          true,
        );
      }

      for (const [namespace, resource] of [
        [beta, "pods"],
        [beta, "services"],
        [beta, "secrets"],
        [core, "pods"],
        [core, "services"],
        [core, "secrets"],
      ]) {
        expect(
          await canI(secondmateIdentity, namespace!, "get", resource!),
        ).toBe(false);
      }

      await requireKubectl([
        "--namespace",
        alpha,
        "--as",
        firstmateIdentity,
        "delete",
        "pod/agentos-secondmate-0",
        "--wait=true",
      ]);
      expect(
        await waitForPodUid(
          alpha,
          "agentos-secondmate-0",
          secondmatePodUid,
        ),
      ).not.toBe(secondmatePodUid);
      expect(
        await requireKubectl([
          "--namespace",
          alpha,
          "get",
          "persistentvolumeclaim/home-agentos-secondmate-0",
          "--output=jsonpath={.metadata.uid}",
        ]),
      ).toBe(secondmatePvcUid);

      await requireKubectl([
        "--namespace",
        alpha,
        "--as",
        secondmateIdentity,
        "apply",
        "--server-side",
        "--kustomize",
        childFixture,
      ]);
      await requireKubectl([
        "--namespace",
        alpha,
        "rollout",
        "status",
        "statefulset/agentos-crewmate",
        "--timeout=180s",
      ]);

      const podUid = await requireKubectl([
        "--namespace",
        alpha,
        "get",
        "pod/agentos-crewmate-0",
        "--output=jsonpath={.metadata.uid}",
      ]);
      const pvcUid = await requireKubectl([
        "--namespace",
        alpha,
        "get",
        "persistentvolumeclaim/home-agentos-crewmate-0",
        "--output=jsonpath={.metadata.uid}",
      ]);

      await requireKubectl([
        "--namespace",
        alpha,
        "--as",
        secondmateIdentity,
        "delete",
        "pod/agentos-crewmate-0",
        "--wait=true",
      ]);
      const replacementUid = await waitForPodUid(
        alpha,
        "agentos-crewmate-0",
        podUid,
        true,
      );
      expect(replacementUid).not.toBe(podUid);
      expect(
        await requireKubectl([
          "--namespace",
          alpha,
          "get",
          "persistentvolumeclaim/home-agentos-crewmate-0",
          "--output=jsonpath={.metadata.uid}",
        ]),
      ).toBe(pvcUid);

      await requireKubectl([
        "--namespace",
        alpha,
        "--as",
        secondmateIdentity,
        "delete",
        "--kustomize",
        childFixture,
        "--wait=true",
      ]);
      expect(
        await requireKubectl([
          "--namespace",
          alpha,
          "get",
          "persistentvolumeclaim/home-agentos-crewmate-0",
          "--output=jsonpath={.metadata.uid}",
        ]),
      ).toBe(pvcUid);
    } finally {
      await kubectl([
        "delete",
        "namespace",
        alpha,
        beta,
        core,
        "--ignore-not-found=true",
        "--wait=true",
      ]);
      await kubectl([
        "delete",
        "--kustomize",
        admission,
        "--ignore-not-found=true",
        "--wait=true",
      ]);
    }
  },
  300_000,
);
