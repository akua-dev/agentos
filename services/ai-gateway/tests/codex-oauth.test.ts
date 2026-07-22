import { describe, expect, test } from "bun:test";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import {
  loginOpenAICodexDeviceCode,
  refreshOpenAICodexToken,
} from "../src/codex-oauth.ts";

const credential: OAuthCredential = {
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: 9_999,
};

function oauth(overrides: Partial<OAuthAuth>): OAuthAuth {
  return {
    name: "OpenAI Codex",
    login: async () => credential,
    refresh: async () => credential,
    toAuth: async (value) => ({ apiKey: value.access }),
    ...overrides,
  };
}

describe("Pi provider-owned Codex OAuth adapter", () => {
  test("selects the headless device-code flow and relays its instructions", async () => {
    let selected: string | undefined;
    let observedDeviceCode: unknown;
    const client = oauth({
      login: async (interaction) => {
        selected = await interaction.prompt({
          type: "select",
          message: "Select OpenAI Codex login method:",
          options: [
            { id: "browser", label: "Browser" },
            { id: "device_code", label: "Device code" },
          ],
        });
        interaction.notify({
          type: "device_code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.openai.com/codex/device",
          intervalSeconds: 5,
          expiresInSeconds: 900,
        });
        return credential;
      },
    });

    const result = await loginOpenAICodexDeviceCode({
      oauth: client,
      onDeviceCode: (info) => {
        observedDeviceCode = info;
      },
    });

    expect(selected).toBe("device_code");
    expect(observedDeviceCode).toEqual({
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
    expect(result).toEqual(credential);
  });

  test("refreshes through the provider-owned OAuth implementation", async () => {
    let observedCredential: OAuthCredential | undefined;
    const refreshed: OAuthCredential = {
      type: "oauth",
      access: "next-access-token",
      refresh: "next-refresh-token",
      expires: 19_999,
    };
    const client = oauth({
      refresh: async (value) => {
        observedCredential = value;
        return refreshed;
      },
    });

    const result = await refreshOpenAICodexToken("old-refresh-token", {
      oauth: client,
    });

    expect(observedCredential).toEqual({
      type: "oauth",
      access: "",
      refresh: "old-refresh-token",
      expires: 0,
    });
    expect(result).toEqual(refreshed);
  });
});
