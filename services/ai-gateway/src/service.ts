import { join } from "node:path";
import { AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS } from "@akua-dev/agentos";
import type { CodexOAuthClient, AccountVault } from "./accounts.ts";
import { createAccountVault, createAccountVaultStore } from "./accounts.ts";
import {
  createProxyHandler,
  isClientAuthorized,
  type FetchImplementation,
} from "./proxy.ts";
import type { GatewayRequestTelemetry, GatewayTelemetry } from "./telemetry.ts";
import { createRoutingState } from "./routing-state.ts";
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
  telemetry?: GatewayTelemetry;
  clock?: () => number;
}

export interface AIGatewayService {
  vault: AccountVault;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export async function createAIGatewayService(
  options: AIGatewayServiceOptions,
): Promise<AIGatewayService> {
  const clock = options.clock ?? Date.now;
  const vault = createAccountVault({
    store: createAccountVaultStore(
      join(options.stateDirectory, "accounts.json"),
    ),
    oauth: options.oauth,
    clock,
    refreshDirectory: options.stateDirectory,
  });
  const routing = await createRoutingState(
    join(options.stateDirectory, "routing.sqlite"),
    defaultRoutingConfig,
  );
  const usage = new Map<string, UsageSnapshot>();
  await vault.list();

  const fallbackAvailable = () =>
    options.allowApiKeyFallback && Boolean(options.openAIApiKey?.trim());

  const readiness = async () => {
    if (!options.clientToken) {
      return {
        reasons: ["client_identity_unavailable"],
        status: "not_ready",
        version: 1,
      } as const;
    }
    if (fallbackAvailable()) {
      return { reasons: [], status: "ready", version: 1 } as const;
    }
    const accounts = await vault.list();
    const candidates = accounts.map((account): Candidate => {
      const snapshot = usage.get(account.id);
      return {
        accountId: account.id,
        label: account.label,
        needsReauth: account.needsReauth,
        ...(snapshot === undefined ? {} : { usage: snapshot }),
      };
    });
    const decision = await routing.evaluate({ candidates, now: clock() });
    if (decision.accountId !== undefined) {
      return { reasons: [], status: "ready", version: 1 } as const;
    }
    if (accounts.some((account) => !account.needsReauth)) {
      const capacityUnknown = decision.candidates.some(
        ({ rejectionCode }) => rejectionCode === "usage_unknown",
      );
      return {
        reasons: [
          capacityUnknown
            ? "provider_capacity_unknown"
            : "provider_capacity_degraded",
        ],
        status: "degraded",
        version: 1,
      } as const;
    }
    return {
      reasons: ["provider_credential_unavailable"],
      status: "not_ready",
      version: 1,
    } as const;
  };

  const acquire = async (
    sessionKey: string | undefined,
    signal: AbortSignal,
    requestTelemetry: GatewayRequestTelemetry,
  ): Promise<RouteLease | undefined> => {
    const summaries = await vault.list();
    const candidates = await Promise.all(
      summaries.map(async (summary): Promise<Candidate> => {
        if (summary.needsReauth) {
          return {
            accountId: summary.id,
            label: summary.label,
            needsReauth: true,
          };
        }
        let snapshot = usage.get(summary.id);
        if (!snapshot || clock() - snapshot.observedAt >= USAGE_CACHE_MS) {
          let probedAccessToken: string | undefined;
          try {
            const credential = await vault.getFreshCredential(
              summary.id,
              signal,
            );
            probedAccessToken = credential.accessToken;
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
            if (
              error instanceof CodexUsageHttpError &&
              error.status === 401 &&
              probedAccessToken !== undefined
            ) {
              await vault.markNeedsReauth(summary.id, probedAccessToken);
              return {
                accountId: summary.id,
                label: summary.label,
                needsReauth: true,
              };
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

    const observationNow = clock();
    for (const candidate of candidates) {
      const snapshot = candidate.usage;
      if (!snapshot) continue;
      requestTelemetry.quotaObservation(
        quotaObservationAgeSeconds(observationNow, snapshot.observedAt),
        snapshot.stale,
      );
    }

    const reservation = await routing.acquire({
      candidates,
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
      credential = await vault.getFreshCredential(
        reservation.accountId,
        signal,
      );
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
      renew: () => routing.renew(reservation.leaseToken, clock()),
      release: async () => {
        await routing.release(reservation.leaseToken);
      },
      recordResponse: async (status, headers) => {
        const responseAt = clock();
        if (status === 401) {
          await vault.markNeedsReauth(
            reservation.accountId,
            credential.accessToken,
          );
        }
        await routing.recordResponse(
          reservation.accountId,
          status,
          headers,
          responseAt,
        );
      },
    };
  };

  const proxy = createProxyHandler({
    clientToken: options.clientToken,
    acquire,
    fetchImpl: options.fetchImpl,
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  });

  return {
    vault,
    close: routing.close,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ status: "ok" });
      }
      if (request.method === "GET" && url.pathname === "/readyz") {
        const diagnostic = await readiness();
        return Response.json(
          diagnostic,
          { status: diagnostic.status === "not_ready" ? 503 : 200 },
        );
      }
      if (request.method === "GET" && url.pathname === "/readyz/client") {
        if (!isClientAuthorized(request, options.clientToken)) {
          return Response.json(
            {
              reasons: ["client_unauthorized"],
              status: "not_ready",
              version: 1,
            },
            { status: 401 },
          );
        }
        const diagnostic = await readiness();
        return Response.json(
          diagnostic,
          { status: diagnostic.status === "not_ready" ? 503 : 200 },
        );
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
                    ...(snapshot.shortWindow
                      ? { shortWindow: snapshot.shortWindow }
                      : {}),
                    ...(snapshot.weeklyWindow
                      ? { weeklyWindow: snapshot.weeklyWindow }
                      : {}),
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

function quotaObservationAgeSeconds(now: number, observedAt: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(observedAt)) return 0;
  return Math.min(
    AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS,
    Math.max(0, now - observedAt) / 1_000,
  );
}
