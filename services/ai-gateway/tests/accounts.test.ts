import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import {
  AccountNeedsReauthError,
  createAccountVault,
  createAccountVaultStore,
  extractCodexAccountId,
} from "../src/accounts.ts";

function accessToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function credentials(accountId: string, expires: number, refresh = "refresh-secret"): OAuthCredentials {
  return { access: accessToken(accountId), refresh, expires };
}

describe("server-owned Codex account vault", () => {
  test("uses a stable opaque ID and exposes no provider identity or token in list output", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-gateway-accounts-"));
    const vault = createAccountVault({
      store: createAccountVaultStore(join(root, "accounts.json")),
      refreshDirectory: root,
      oauth: { refresh: async () => credentials("provider-a", Date.now() + 3_600_000) },
      clock: () => 1_000,
    });
    const id = await vault.addFromOAuth("  Team\nA  ", credentials("provider-a", 9_999));

    expect(id).toMatch(/^codex-[a-f0-9]{12}$/);
    expect(await vault.list()).toEqual([
      { id, label: "Team A", expiresAt: 9_999, needsReauth: false },
    ]);
    expect(JSON.stringify(await vault.list())).not.toContain("provider-a");
    expect(extractCodexAccountId(credentials("provider-a", 9_999).access)).toBe("provider-a");
  });

  test("serializes refresh and persists one rotated credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-gateway-refresh-"));
    let refreshes = 0;
    const store = createAccountVaultStore(join(root, "accounts.json"));
    const vault = createAccountVault({
      store,
      refreshDirectory: root,
      oauth: {
        refresh: async () => {
          refreshes += 1;
          await Bun.sleep(10);
          return credentials("provider-a", 1_000_000, "rotated-refresh");
        },
      },
      clock: () => 100_000,
    });
    const id = await vault.addFromOAuth("A", credentials("provider-a", 100_001));

    const [left, right] = await Promise.all([
      vault.getFreshCredential(id),
      vault.getFreshCredential(id),
    ]);
    expect(refreshes).toBe(1);
    expect(left).toEqual(right);
    expect(left.accessToken).toBe(accessToken("provider-a"));
    expect((await store.read()).accounts[0]?.refreshToken).toBe("rotated-refresh");
  });

  test("marks the account for reauthentication when refresh changes identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-gateway-identity-"));
    const store = createAccountVaultStore(join(root, "accounts.json"));
    const vault = createAccountVault({
      store,
      refreshDirectory: root,
      oauth: { refresh: async () => credentials("provider-b", 1_000_000) },
      clock: () => 100_000,
    });
    const id = await vault.addFromOAuth("A", credentials("provider-a", 100_001));

    await expect(vault.getFreshCredential(id)).rejects.toBeInstanceOf(AccountNeedsReauthError);
    expect(await vault.list()).toEqual([
      expect.objectContaining({ id, needsReauth: true }),
    ]);
  });
});
