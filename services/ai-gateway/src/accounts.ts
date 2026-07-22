import { createHash } from "node:crypto";
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { createAtomicJsonStore, type AtomicJsonStore } from "./storage.ts";

const CLAIM_PATH = "https://api.openai.com/auth";
const REFRESH_EARLY_MS = 300_000;
const REFRESH_LOCK_TIMEOUT_MS = 5_000;
const MAX_LABEL_CODE_POINTS = 80;

const ManagedAccountSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).max(80),
    providerAccountId: z.string().min(1),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    needsReauth: z.boolean(),
  })
  .strict();

const AccountVaultFileSchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(ManagedAccountSchema),
  })
  .strict();

export type AccountVaultFile = z.infer<typeof AccountVaultFileSchema>;

export interface ManagedAccountSummary {
  id: string;
  label: string;
  expiresAt: number;
  needsReauth: boolean;
}

export interface FreshCredential {
  providerAccountId: string;
  accessToken: string;
  expiresAt: number;
}

export interface CodexOAuthClient {
  refresh(refreshToken: string): Promise<OAuthCredentials>;
}

export interface AccountVault {
  list(): Promise<ManagedAccountSummary[]>;
  addFromOAuth(label: string, credentials: OAuthCredentials): Promise<string>;
  getFreshCredential(id: string, signal?: AbortSignal): Promise<FreshCredential>;
  remove(id: string): Promise<boolean>;
  markNeedsReauth(id: string, rejectedAccessToken?: string): Promise<boolean>;
}

export class InvalidCodexTokenError extends Error {
  override readonly name = "InvalidCodexTokenError";

  constructor() {
    super("The Codex access token does not contain a usable account identity");
  }
}

export class AccountNeedsReauthError extends Error {
  override readonly name = "AccountNeedsReauthError";

  constructor() {
    super("This Codex account must be authenticated again");
  }
}

export class AccountNotFoundError extends Error {
  override readonly name = "AccountNotFoundError";

  constructor(id: string) {
    super(`No managed Codex account exists for ${id}`);
  }
}

export class TokenRefreshTransientError extends Error {
  override readonly name = "TokenRefreshTransientError";

  constructor() {
    super("Codex token refresh failed temporarily");
  }
}

export function createAccountVaultStore(path: string): AtomicJsonStore<AccountVaultFile> {
  return createAtomicJsonStore({
    path,
    schema: AccountVaultFileSchema,
    createDefault: () => ({ version: 1, accounts: [] }),
  });
}

export function extractCodexAccountId(accessToken: string): string {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || parts[1] === undefined) throw new Error("invalid token shape");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (typeof payload !== "object" || payload === null || !(CLAIM_PATH in payload)) {
      throw new Error("missing auth claim");
    }
    const auth = payload[CLAIM_PATH as keyof typeof payload];
    if (
      typeof auth !== "object" ||
      auth === null ||
      !("chatgpt_account_id" in auth) ||
      typeof auth.chatgpt_account_id !== "string" ||
      auth.chatgpt_account_id.length === 0
    ) {
      throw new Error("missing account id");
    }
    return auth.chatgpt_account_id;
  } catch {
    throw new InvalidCodexTokenError();
  }
}

export function createAccountVault(options: {
  store: AtomicJsonStore<AccountVaultFile>;
  oauth: CodexOAuthClient;
  clock: () => number;
  refreshDirectory: string;
}): AccountVault {
  const inFlightRefreshes = new Map<string, Promise<FreshCredential>>();

  const find = async (id: string) => {
    const account = (await options.store.read()).accounts.find((value) => value.id === id);
    if (!account) throw new AccountNotFoundError(id);
    return account;
  };

  const fresh = (account: Awaited<ReturnType<typeof find>>): FreshCredential => ({
    providerAccountId: account.providerAccountId,
    accessToken: account.accessToken,
    expiresAt: account.expiresAt,
  });

  const refresh = async (id: string): Promise<FreshCredential> =>
    withRefreshLock(options.refreshDirectory, id, async () => {
      const account = await find(id);
      if (account.needsReauth) throw new AccountNeedsReauthError();
      if (!needsRefresh(account.expiresAt, options.clock())) return fresh(account);

      let credentials: OAuthCredentials;
      try {
        credentials = await options.oauth.refresh(account.refreshToken);
      } catch (error) {
        if (isDefinitiveAuthFailure(error)) {
          await invalidateAccount(options.store, account);
          throw new AccountNeedsReauthError();
        }
        throw new TokenRefreshTransientError();
      }

      let providerAccountId: string;
      try {
        providerAccountId = extractCodexAccountId(credentials.access);
      } catch {
        await invalidateAccount(options.store, account);
        throw new AccountNeedsReauthError();
      }
      if (
        providerAccountId !== account.providerAccountId ||
        !credentials.refresh ||
        !Number.isFinite(credentials.expires)
      ) {
        await invalidateAccount(options.store, account);
        throw new AccountNeedsReauthError();
      }

      const updated = await options.store.update((file) => ({
        ...file,
        accounts: file.accounts.map((value) =>
          value.id === id && sameCredentialSource(value, account)
            ? {
                ...value,
                accessToken: credentials.access,
                refreshToken: credentials.refresh,
                expiresAt: credentials.expires,
                updatedAt: options.clock(),
                needsReauth: false,
              }
            : value,
        ),
      }));
      const saved = updated.accounts.find((value) => value.id === id);
      if (!saved) throw new AccountNotFoundError(id);
      return fresh(saved);
    });

  return {
    async list() {
      return (await options.store.read()).accounts.map((account) => ({
        id: account.id,
        label: account.label,
        expiresAt: account.expiresAt,
        needsReauth: account.needsReauth,
      }));
    },

    async addFromOAuth(label, credentials) {
      const providerAccountId = extractCodexAccountId(credentials.access);
      if (!credentials.refresh || !Number.isFinite(credentials.expires)) {
        throw new InvalidCodexTokenError();
      }
      const id = deriveManagedAccountId(providerAccountId);
      const now = options.clock();
      const normalizedLabel = normalizeAccountLabel(label, `Account ${id.slice(-6)}`);
      await options.store.update((file) => {
        const existing = file.accounts.find(
          (account) => account.providerAccountId === providerAccountId,
        );
        const next = {
          id,
          label: normalizedLabel,
          providerAccountId,
          accessToken: credentials.access,
          refreshToken: credentials.refresh,
          expiresAt: credentials.expires,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          needsReauth: false,
        };
        return {
          ...file,
          accounts: existing
            ? file.accounts.map((account) =>
                account.providerAccountId === providerAccountId ? next : account,
              )
            : [...file.accounts, next],
        };
      });
      return id;
    },

    async getFreshCredential(id, signal) {
      signal?.throwIfAborted();
      const account = await find(id);
      if (account.needsReauth) throw new AccountNeedsReauthError();
      if (!needsRefresh(account.expiresAt, options.clock())) return fresh(account);
      const pending = inFlightRefreshes.get(id);
      if (pending) return raceWithSignal(pending, signal);
      const promise = refresh(id).finally(() => {
        if (inFlightRefreshes.get(id) === promise) inFlightRefreshes.delete(id);
      });
      inFlightRefreshes.set(id, promise);
      return raceWithSignal(promise, signal);
    },

    async remove(id) {
      let removed = false;
      await options.store.update((file) => ({
        ...file,
        accounts: file.accounts.filter((account) => {
          if (account.id !== id) return true;
          removed = true;
          return false;
        }),
      }));
      return removed;
    },

    async markNeedsReauth(id, rejectedAccessToken) {
      let marked = false;
      await options.store.update((file) => ({
        ...file,
        accounts: file.accounts.map((account) => {
          if (
            account.id !== id ||
            (rejectedAccessToken !== undefined && account.accessToken !== rejectedAccessToken)
          ) {
            return account;
          }
          marked = true;
          return { ...account, needsReauth: true, updatedAt: options.clock() };
        }),
      }));
      return marked;
    },
  };
}

function deriveManagedAccountId(providerAccountId: string): string {
  return `codex-${createHash("sha256").update(providerAccountId).digest("hex").slice(0, 12)}`;
}

function normalizeAccountLabel(label: string, fallback: string): string {
  const printable = Array.from(label, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && codePoint !== 0x7f ? character : " ";
  })
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim();
  return Array.from(printable || fallback).slice(0, MAX_LABEL_CODE_POINTS).join("");
}

function needsRefresh(expiresAt: number, now: number): boolean {
  return expiresAt <= now + REFRESH_EARLY_MS;
}

async function invalidateAccount(
  store: AtomicJsonStore<AccountVaultFile>,
  source: AccountVaultFile["accounts"][number],
): Promise<void> {
  await store.update((file) => ({
    ...file,
    accounts: file.accounts.map((account) =>
      account.id === source.id && sameCredentialSource(account, source)
        ? { ...account, needsReauth: true }
        : account,
    ),
  }));
}

function sameCredentialSource(
  left: AccountVaultFile["accounts"][number],
  right: AccountVaultFile["accounts"][number],
): boolean {
  return (
    left.providerAccountId === right.providerAccountId &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken
  );
}

async function withRefreshLock<T>(
  directory: string,
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = join(directory, `.${id}.refresh-lock-target`);
  const handle = await open(target, "a", 0o600);
  await handle.close();
  await chmod(target, 0o600);
  const deadline = Date.now() + REFRESH_LOCK_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      const release = await lockfile.lock(target, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
      });
      try {
        return await operation();
      } finally {
        await release();
      }
    } catch (error) {
      if (!isLockContention(error)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(10, remaining));
    }
  }
  throw new TokenRefreshTransientError();
}

function isDefinitiveAuthFailure(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code).toLowerCase()
      : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    code === "invalid_grant" ||
    code === "token_revoked" ||
    message.includes("invalid_grant") ||
    message.includes("refresh token was revoked")
  );
}

function isLockContention(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ELOCKED";
}

function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}
