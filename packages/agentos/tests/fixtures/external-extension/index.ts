import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  buildAgentOSStartupPromptEffect,
  decodeHermesProviderAccessConfigMapV1,
  defineAgentOSPiCommandHandler,
  defineAgentOSPiExtension,
  loadHermesProviderAccessConfigMapV1,
  matchHermesProviderAccessConfigMapV1,
  ProviderBudgetKeyInputV1Schema,
  ProviderBudgetReservationRequestError,
  ProviderBudgetReservationRequester,
  ProviderBudgetReservationRequestV1Schema,
  denyProviderBudgetReservationRequester,
  providerBudgetSubjectName,
  registerAgentOSInstructionsEffect,
  registerAgentOSRuntimeEffect,
  registerAgentOSStartupEffect,
  type AgentOSRegistrationV1,
  type AgentOSStartupContributionV1,
  type KubernetesWorkloadPrincipalV1,
  type HermesProviderAccessRequestV1,
  type WorkloadIdentityV1,
} from "@akua-dev/agentos";
import { Effect } from "effect";

export const exampleEgressAudience = AGENTOS_EGRESS_TOKEN_AUDIENCE;
export const exampleHermesPrincipal: KubernetesWorkloadPrincipalV1 = {
  kind: "kubernetes_workload",
  namespace: "hermes-akua",
  serviceAccountName: "hermes-codex-worker",
  policyRevision: 7,
  policyResourceVersion: "18422",
  hermesProfile: "fleet-codex",
};
export const exampleHermesBudgetSubject = providerBudgetSubjectName(
  exampleHermesPrincipal,
);
export const exampleHermesBudgetKeySchema = ProviderBudgetKeyInputV1Schema;
export const exampleHermesReservationRequestSchema =
  ProviderBudgetReservationRequestV1Schema;
export const exampleHermesReservationRequester:
  ProviderBudgetReservationRequester["Service"] =
    denyProviderBudgetReservationRequester;
export const exampleHermesReservationError =
  ProviderBudgetReservationRequestError.make({ code: "unavailable" });
export const exampleHermesPolicyDecoders = {
  decode: decodeHermesProviderAccessConfigMapV1,
  load: loadHermesProviderAccessConfigMapV1,
  match: matchHermesProviderAccessConfigMapV1,
};
export const exampleHermesAccessRequest: HermesProviderAccessRequestV1 = {
  namespace: "hermes-akua",
  serviceAccountName: "hermes-codex-worker",
  policyRevision: 7,
  policyResourceVersion: "18422",
  provider: "openai",
  credentialDomain: "fleet-codex",
  model: "gpt-5.6-sol",
  capability: "responses.create",
  atMillis: 1_786_435_200_000,
};
export const exampleWorkloadIdentity: WorkloadIdentityV1 = {
  schemaVersion: 1,
  agentId: "11111111-1111-4111-8111-111111111111",
  role: "second_mate",
  fleet: "agentos",
  domain: "platform",
  assignmentId: null,
  kubernetesNamespace: "agentos-domain-platform",
  kubernetesPod: "agentos-platform-mate-0",
  podUid: "22222222-2222-4222-8222-222222222222",
  serviceAccountName: "agentos-platform-mate",
  serviceAccountUid: "33333333-3333-4333-8333-333333333333",
};

export const contribution: AgentOSStartupContributionV1 = {
  version: 1,
  id: "@example/extension:startup",
  skill: "example-agentos-startup",
  instruction: "Inspect the example customization through native tools.",
};

const replacement: AgentOSRegistrationV1 = {
  version: 1,
  id: "@example/extension:runtime",
  names: { version: 1, commands: ["example-agentos-status"] },
  register(pi) {
    return Effect.sync(() => {
      pi.registerCommand("example-agentos-status", {
        description: "Show the example customization status",
        handler: defineAgentOSPiCommandHandler((_args, context) =>
          Effect.sync(() => context.ui.notify("example ready", "info"))),
      });
    });
  },
};

export const registerExampleAgentOS = defineAgentOSPiExtension((pi) =>
  Effect.gen(function*() {
    yield* registerAgentOSInstructionsEffect(pi, [
      {
        version: 1,
        id: "@example/extension:instructions",
        content: "Use the example organization's reviewed policy.",
      },
    ]);
    yield* registerAgentOSRuntimeEffect(pi, [replacement]);
    yield* registerAgentOSStartupEffect(pi, {
      customType: "@example/extension:startup",
      prompt: yield* buildAgentOSStartupPromptEffect([contribution]),
      requiredSkills: [contribution.skill],
    });
  })
);
