import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

type Environment = Record<string, string | undefined>;

const PLACEHOLDER_CODEX_TOKEN = createPlaceholderCodexToken();

export function buildQuotaRouterProvider(
  environment: Environment,
  installedModels: Model<Api>[],
): ProviderConfig | undefined {
  const configuredUrl = environment.QUOTA_ROUTER_URL?.trim();
  const configuredToken = environment.QUOTA_ROUTER_TOKEN?.trim();
  if (!configuredUrl || !configuredToken) return undefined;
  const baseUrl = normalizeBaseUrl(configuredUrl);
  const models = installedModels
    .filter((model) => model.provider === "openai-codex")
    .map(toProviderModel);
  if (models.length === 0) return undefined;

  return {
    name: "Fleet Codex",
    baseUrl,
    api: "openai-codex-responses",
    // Pi's Codex transport expects a JWT-shaped upstream token. The router
    // authenticates the separate Fleet header, strips both inbound values and
    // injects the selected account credential.
    apiKey: PLACEHOLDER_CODEX_TOKEN,
    headers: { "X-Quota-Router-Token": "$QUOTA_ROUTER_TOKEN" },
    models,
  };
}

export function configureQuotaRouter(
  pi: Pick<ExtensionAPI, "registerProvider">,
  installedModels: Model<Api>[],
  environment: Environment = process.env,
): void {
  const provider = buildQuotaRouterProvider(environment, installedModels);
  if (provider) pi.registerProvider("fleet-codex", provider);
}

export default function quotaRouterExtension(pi: ExtensionAPI): void {
  if (!process.env.QUOTA_ROUTER_URL?.trim() || !process.env.QUOTA_ROUTER_TOKEN?.trim()) return;
  pi.on("session_start", (_event, context) => {
    configureQuotaRouter(pi, context.modelRegistry.getAll());
  });
}

function toProviderModel(model: Model<Api>): ProviderModelConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: [...model.input],
    cost: structuredClone(model.cost),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.compat ? { compat: structuredClone(model.compat) } : {}),
  };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("QUOTA_ROUTER_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("QUOTA_ROUTER_URL must not contain credentials, query parameters or a fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("QUOTA_ROUTER_URL must point to the service root");
  }
  return url.origin;
}

function createPlaceholderCodexToken(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "fleet-router" },
    }),
  ).toString("base64url");
  return `${header}.${payload}.placeholder`;
}
