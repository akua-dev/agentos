import { AxiError } from "axi-sdk-js";

export const attachHelp = `Attach to an AgentOS terminal

Usage:
  agentos attach <agent> --context <context> [--namespace <namespace>]

The Kubernetes context is always explicit. AgentOS locates one Ready Pod by
its released agent label and opens the Herdr session declared on that Pod.
`;

type KubernetesPodList = {
  items?: Array<{
    metadata?: {
      annotations?: Record<string, string>;
      name?: string;
    };
    status?: {
      containerStatuses?: Array<{ name?: string; ready?: boolean }>;
      phase?: string;
    };
  }>;
};

export async function attachAgent(args: string[]) {
  const { agent, context, namespace } = parseAttachArgs(args);
  const query = await runKubectl([
    "--context",
    context,
    "--namespace",
    namespace,
    "get",
    "pods",
    "--selector",
    `agentos.akua.dev/agent=${agent}`,
    "--output",
    "json",
  ]);

  let podList: KubernetesPodList;
  try {
    podList = JSON.parse(query.stdout) as KubernetesPodList;
  } catch {
    throw new AxiError("kubectl returned invalid Pod data", "KUBERNETES_ERROR", [
      `Inspect the selected context with \`kubectl --context ${context} get pods -n ${namespace}\``,
    ]);
  }

  const pods = podList.items ?? [];
  if (pods.length !== 1) {
    throw new AxiError(
      `Expected exactly one Pod for agent ${agent}, found ${pods.length}`,
      pods.length === 0 ? "AGENT_NOT_FOUND" : "AMBIGUOUS_AGENT",
      [`Inspect agent labels in context \`${context}\`, namespace \`${namespace}\``],
    );
  }

  const pod = pods[0]!;
  const podName = pod.metadata?.name;
  const container = pod.metadata?.annotations?.["agentos.akua.dev/container"];
  const session = pod.metadata?.annotations?.["agentos.akua.dev/herdr-session"];
  const containerReady = pod.status?.containerStatuses?.some(
    (status) => status.name === container && status.ready === true,
  );
  if (
    !podName ||
    !container ||
    !session ||
    pod.status?.phase !== "Running" ||
    !containerReady
  ) {
    throw new AxiError(
      `Agent ${agent} does not have one attachable Ready terminal`,
      "AGENT_NOT_READY",
      [`Inspect Pod status in context \`${context}\`, namespace \`${namespace}\``],
    );
  }

  const exitCode = await Bun.spawn(
    [
      "kubectl",
      "--context",
      context,
      "--namespace",
      namespace,
      "exec",
      "--stdin",
      "--tty",
      `pod/${podName}`,
      "--container",
      container,
      "--",
      "herdr",
      "--session",
      session,
    ],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  ).exited;
  if (exitCode !== 0) {
    throw new AxiError(
      `Herdr attach exited with status ${exitCode}`,
      "ATTACH_FAILED",
      [`Re-run after inspecting Pod \`${podName}\``],
    );
  }

  return {
    attached: { agent, container, context, namespace, pod: podName, session },
  };
}

function parseAttachArgs(args: string[]) {
  let agent: string | undefined;
  let context: string | undefined;
  let namespace = "agentos";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--context" || argument === "--namespace") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new AxiError(`Missing value for ${argument}`, "VALIDATION_ERROR", [
          "Run `agentos attach --help`",
        ]);
      }
      if (argument === "--context") context = value;
      else namespace = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("-") || agent) {
      throw new AxiError(`Unknown attach argument: ${argument}`, "VALIDATION_ERROR", [
        "Run `agentos attach --help`",
      ]);
    }
    agent = argument;
  }

  if (!agent || !context) {
    throw new AxiError(
      "Attach requires an agent and explicit Kubernetes context",
      "VALIDATION_ERROR",
      ["Run `agentos attach <agent> --context <context>`"],
    );
  }
  if (!isKubernetesName(agent) || !isKubernetesName(namespace)) {
    throw new AxiError(
      "Agent and namespace must be valid Kubernetes names",
      "VALIDATION_ERROR",
      ["Use lowercase letters, numbers and hyphens"],
    );
  }

  return { agent, context, namespace };
}

function isKubernetesName(value: string) {
  return value.length <= 63 && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value);
}

async function runKubectl(args: string[]) {
  const process = Bun.spawn(["kubectl", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new AxiError(
      stderr.trim() || `kubectl exited with status ${exitCode}`,
      "KUBERNETES_ERROR",
      ["Verify the explicit context, namespace and Kubernetes credentials"],
    );
  }
  return { stdout };
}
