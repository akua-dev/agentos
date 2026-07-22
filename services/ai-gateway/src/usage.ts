import type { UsageSnapshot, UsageWindow } from "./types.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const SHORT_WINDOW_SECONDS = 18_000;
const WEEKLY_WINDOW_SECONDS = 604_800;

type WindowKind = "short" | "weekly";

interface ParsedWindow {
  kind: WindowKind;
  value: UsageWindow;
}

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
  const root = asRecord(body);
  const rateLimit = asRecord(root.rate_limit);
  const windows = [
    parseWindow(rateLimit.primary_window ?? rateLimit.primary, "short"),
    parseWindow(rateLimit.secondary_window ?? rateLimit.secondary, "weekly"),
  ].filter((window): window is ParsedWindow => window !== undefined);
  if (windows.length === 0) throw new CodexUsageParseError();
  const shortWindow = oneWindow(windows, "short");
  const weeklyWindow = oneWindow(windows, "weekly");
  const planType =
    typeof root.plan_type === "string"
      ? root.plan_type
      : typeof root.planType === "string"
        ? root.planType
        : undefined;
  const credits = isRecord(root.credits) ? root.credits : undefined;
  const creditsRemaining =
    credits && typeof credits.balance === "number" && Number.isFinite(credits.balance)
      ? Math.max(0, credits.balance)
      : undefined;

  return {
    accountId,
    observedAt,
    ...(shortWindow ? { shortWindow } : {}),
    ...(weeklyWindow ? { weeklyWindow } : {}),
    stale: false,
    ...(planType ? { planType } : {}),
    ...(creditsRemaining !== undefined ? { creditsRemaining } : {}),
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

function parseWindow(value: unknown, fallbackKind: WindowKind): ParsedWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = value.used_percent ?? value.usedPercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    throw new CodexUsageParseError();
  }
  const resetsAt = normalizeReset(value.reset_at ?? value.resetsAt);
  return {
    kind: classifyWindow(value, fallbackKind),
    value: {
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    },
  };
}

function classifyWindow(value: Record<string, unknown>, fallbackKind: WindowKind): WindowKind {
  const seconds = durationSeconds(value);
  if (seconds === undefined) return fallbackKind;
  if (seconds === SHORT_WINDOW_SECONDS) return "short";
  if (seconds === WEEKLY_WINDOW_SECONDS) return "weekly";
  throw new CodexUsageParseError();
}

function durationSeconds(value: Record<string, unknown>): number | undefined {
  if ("limit_window_seconds" in value) {
    const seconds = value.limit_window_seconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) throw new CodexUsageParseError();
    return seconds;
  }
  if ("windowDurationMins" in value) {
    const minutes = value.windowDurationMins;
    if (typeof minutes !== "number" || !Number.isFinite(minutes)) throw new CodexUsageParseError();
    return minutes * 60;
  }
  return undefined;
}

function oneWindow(windows: ParsedWindow[], kind: WindowKind): UsageWindow | undefined {
  const matches = windows.filter((window) => window.kind === kind);
  if (matches.length > 1) throw new CodexUsageParseError();
  return matches[0]?.value;
}

function normalizeReset(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value < 1_000_000_000_000 ? value * 1_000 : value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new CodexUsageParseError();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
