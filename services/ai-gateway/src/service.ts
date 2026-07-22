import { join } from "node:path";
import type { CodexOAuthClient, AccountVault } from "./accounts.ts";
import { createAccountVault, createAccountVaultStore } from "./accounts.ts";
import {
  createProxyHandler,
  isClientAuthorized,
  type FetchImplementation,
} from "./proxy.ts";
import { createRoutingState, createRoutingStateStore } from "./routing-state.ts";
import { defaultRoutingConfig } from "./selection.ts";
import type { Candidate, RouteLease, UsageSnapshot } from "./types.ts";
import { CodexUsageHttpError, fetchCodexUsage } from "./usage.ts";

const USAGE_CACHE_MS = 60_000;

export interface AIGatewayServiceOptions {
  stateDirectory: string;
  clientToken: string;
  allowApiKeyFallback: boolean;
  openAIApiKey?: string;
  oauth: CodexOAuthClient;
  fetchImpl: FetchImplementation;
  clock?: () => number;
}

export interface AIGatewayService {
  vault: AccountVault;
  fetch(request: Request): Promise<Response>;
}

export async function createAIGatewayService(
  options: AIGatewayServiceOptions,
): Promise<AIGatewayService> {
  const clock = options.clock ?? Date.now;
  const vault = createAccountVault({
    store: createAccountVaultStore(join(options.stateDirectory, "accounts.json")),
    oauth: options.oauth,
    clock,
    refreshDirectory: options.stateDirectory,
  });
  const routingStore = createRoutingStateStore(join(options.stateDirectory, "routing.json"));
  const routing = createRoutingState(routingStore);
  const usage = new Map<string, UsageSnapshot>();
  await Promise.all([routingStore.read(), vault.list()]);

  const fallbackAvailable = () =>
    options.allowApiKeyFallback && Boolean(options.openAIApiKey?.trim());

  const acquire = async (
    sessionKey: string | undefined,
    signal: AbortSignal,
  ): Promise<RouteLease | undefined> => {
    const summaries = await vault.list();
    const candidates = await Promise.all(
      summaries.map(async (summary): Promise<Candidate> => {
        if (summary.needsReauth) {
          return { accountId: summary.id, label: summary.label, needsReauth: true };
        }
        let snapshot = usage.get(summary.id);
        if (!snapshot || clock() - snapshot.observedAt >= USAGE_CACHE_MS) {
          try {
            const credential = await vault.getFreshCredential(summary.id, signal);
            snapshot = await fetchCodexUsage({
              accessToken: credential.accessToken,
              providerAccountId: credential.providerAccountId,
              managedAccountId: summary.id,
              signal,
              fetchImpl: options.fetchImpl,
              clock,
            });
            usage.set(summary.id, snapshot);
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof CodexUsageHttpError && error.status === 401) {
              await vault.markNeedsReauth(summary.id);
              return { accountId: summary.id, label: summary.label, needsReauth: true };
            }
            if (snapshot) snapshot = { ...snapshot, stale: true };
          }
        }
        return {
          accountId: summary.id,
          label: summary.label,
          needsReauth: false,
          ...(snapshot ? { usage: snapshot } : {}),
        };
      }),
    );

    const reservation = await routing.acquire({
      candidates,
      config: defaultRoutingConfig,
      now: clock(),
      ...(sessionKey ? { sessionKey } : {}),
    });
    if (!reservation) {
      const apiKey = options.openAIApiKey?.trim();
      if (!fallbackAvailable() || !apiKey) return undefined;
      return {
        kind: "openai_api_key",
        accountId: "openai-api-key",
        accessToken: apiKey,
        leaseToken: "api-key",
        renew: async () => true,
        release: async () => undefined,
      };
    }

    let credential;
    try {
      credential = await vault.getFreshCredential(reservation.accountId, signal);
    } catch (error) {
      await routing.release(reservation.leaseToken);
      throw error;
    }
    return {
      kind: "codex_oauth",
      accountId: reservation.accountId,
      providerAccountId: credential.providerAccountId,
      accessToken: credential.accessToken,
      leaseToken: reservation.leaseToken,
      renew: () =>
        routing.renew(
          reservation.leaseToken,
          clock(),
          defaultRoutingConfig.reservationTtlMs,
        ),
      release: async () => {
        await routing.release(reservation.leaseToken);
      },
      recordResponse: async (status, headers) => {
        if (status === 401) {
          await vault.markNeedsReauth(reservation.accountId, credential.accessToken);
          return;
        }
        if (status === 429) {
          const blockedAt = clock();
          await routing.block({
            accountId: reservation.accountId,
            kind: "quota",
            blockedAt,
            retryAt: parseRetryAfter(headers.get("retry-after"), blockedAt) ?? blockedAt + 60_000,
          });
        }
      },
    };
  };

  const proxy = createProxyHandler({
    clientToken: options.clientToken,
    acquire,
    fetchImpl: options.fetchImpl,
  });

  return {
    vault,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ status: "ok" });
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        const accounts = await vault.list();
        const ready =
          Boolean(options.clientToken) &&
          (accounts.some((account) => !account.needsReauth) || fallbackAvailable());
        return Response.json({ status: ready ? "ready" : "not_ready" }, { status: ready ? 200 : 503 });
      }
      if (request.method === "GET" && url.pathname === "/status") {
        if (!isClientAuthorized(request, options.clientToken)) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const accounts = (await vault.list()).map((account) => {
          const snapshot = usage.get(account.id);
          return {
            id: account.id,
            label: account.label,
            needsReauth: account.needsReauth,
            expiresAt: account.expiresAt,
            ...(snapshot
              ? {
                  usage: {
                    observedAt: snapshot.observedAt,
                    stale: snapshot.stale,
                    ...(snapshot.shortWindow ? { shortWindow: snapshot.shortWindow } : {}),
                    ...(snapshot.weeklyWindow ? { weeklyWindow: snapshot.weeklyWindow } : {}),
                  },
                }
              : {}),
          };
        });
        return Response.json({
          accounts,
          apiKeyFallback: fallbackAvailable(),
          routing: await routing.summary(clock()),
        });
      }
      return proxy(request);
    },
  };
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(now, date);
}
