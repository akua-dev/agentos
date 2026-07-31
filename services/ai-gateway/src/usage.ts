import { decodeCodexUsage } from "@akua-dev/codex-router/codex";
import { AccountId } from "@akua-dev/codex-router/core";
import { Effect, Result } from "effect";
import type { UsageSnapshot } from "./types.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export class CodexUsageParseError extends Error {
  override readonly name = "CodexUsageParseError";

  constructor() {
    super("The Codex usage response has an unsupported shape");
  }
}

export class CodexUsageHttpError extends Error {
  override readonly name = "CodexUsageHttpError";

  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchCodexUsageOptions {
  accessToken: string;
  providerAccountId: string;
  managedAccountId: string;
  signal?: AbortSignal;
  fetchImpl?: FetchImplementation;
  clock?: () => number;
}

export function parseCodexUsage(
  body: unknown,
  observedAt: number,
  accountId: string,
): UsageSnapshot {
  const decodedResult = Effect.runSync(
    Effect.result(
      decodeCodexUsage(body, observedAt, AccountId.make(accountId)),
    ),
  );
  if (Result.isFailure(decodedResult)) throw new CodexUsageParseError();
  const decoded = decodedResult.success;

  return {
    accountId,
    observedAt: decoded.observedAt,
    shortWindow: {
      usedPercent: decoded.short.usedPercent,
      ...(decoded.short.resetAt === undefined
        ? {}
        : { resetsAt: decoded.short.resetAt }),
    },
    weeklyWindow: {
      usedPercent: decoded.weekly.usedPercent,
      ...(decoded.weekly.resetAt === undefined
        ? {}
        : { resetsAt: decoded.weekly.resetAt }),
    },
    stale: decoded.stale ?? false,
    ...(decoded.planType === undefined
      ? {}
      : { planType: decoded.planType }),
    ...(decoded.credits === undefined
      ? {}
      : { creditsRemaining: decoded.credits }),
  };
}

export async function fetchCodexUsage(options: FetchCodexUsageOptions): Promise<UsageSnapshot> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(USAGE_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.accessToken}`,
        "chatgpt-account-id": options.providerAccountId,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    throw new CodexUsageHttpError("The Codex usage request did not complete");
  }
  if (!response.ok) {
    throw new CodexUsageHttpError(`Codex usage endpoint returned HTTP ${response.status}`, response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CodexUsageParseError();
  }
  return parseCodexUsage(body, (options.clock ?? Date.now)(), options.managedAccountId);
}
