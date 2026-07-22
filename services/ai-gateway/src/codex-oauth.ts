import type {
  OAuthAuth,
  OAuthCredential,
  OAuthCredentials,
  OAuthDeviceCodeInfo,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

type OAuthOptions = {
  oauth?: OAuthAuth;
  signal?: AbortSignal;
};

export async function loginOpenAICodexDeviceCode(
  options: OAuthOptions & {
    onDeviceCode(info: OAuthDeviceCodeInfo): void;
  },
): Promise<OAuthCredentials> {
  return await (options.oauth ?? providerOAuth()).login({
    signal: options.signal,
    prompt: async (prompt) => {
      if (
        prompt.type === "select" &&
        prompt.options.some(({ id }) => id === "device_code")
      ) {
        return "device_code";
      }
      throw new Error(
        `AI Gateway supports only OpenAI Codex device-code login, not ${prompt.type}`,
      );
    },
    notify: (event) => {
      if (event.type !== "device_code") return;
      options.onDeviceCode({
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        intervalSeconds: event.intervalSeconds,
        expiresInSeconds: event.expiresInSeconds,
      });
    },
  });
}

export async function refreshOpenAICodexToken(
  refreshToken: string,
  options: OAuthOptions = {},
): Promise<OAuthCredentials> {
  const credential: OAuthCredential = {
    type: "oauth",
    access: "",
    refresh: refreshToken,
    expires: 0,
  };
  return await (options.oauth ?? providerOAuth()).refresh(
    credential,
    options.signal,
  );
}

function providerOAuth(): OAuthAuth {
  const oauth = openaiCodexProvider().auth.oauth;
  if (!oauth) throw new Error("OpenAI Codex provider has no OAuth implementation");
  return oauth;
}
