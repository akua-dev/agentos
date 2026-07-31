import { expect, test } from "bun:test";
import { join } from "node:path";

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

async function kubectl(args: string[]): Promise<CommandResult> {
  if (!context) throw new Error("Missing disposable Kubernetes context");
  const child = Bun.spawn(["kubectl", "--context", context, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
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
    }
  },
  300_000,
);
