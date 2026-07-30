import {
  AccountId,
  UsageSnapshot,
  UsageWindow,
  type AccountId as AccountIdType
} from "@akua-dev/codex-router-core"
import { Effect, Schema } from "effect"

const shortWindowSeconds = 18_000
const weeklyWindowSeconds = 604_800

const RawWindow = Schema.Struct({
  used_percent: Schema.optionalKey(Schema.Number),
  usedPercent: Schema.optionalKey(Schema.Number),
  reset_at: Schema.optionalKey(Schema.Number),
  resetsAt: Schema.optionalKey(Schema.Number),
  limit_window_seconds: Schema.optionalKey(Schema.Number),
  windowDurationMins: Schema.optionalKey(Schema.Number)
})

const RawRateLimit = Schema.Struct({
  primary_window: Schema.optionalKey(RawWindow),
  secondary_window: Schema.optionalKey(RawWindow),
  primary: Schema.optionalKey(RawWindow),
  secondary: Schema.optionalKey(RawWindow)
})

const RawUsage = Schema.Struct({
  rate_limit: Schema.optionalKey(RawRateLimit),
  rateLimit: Schema.optionalKey(RawRateLimit),
  plan_type: Schema.optionalKey(Schema.String),
  planType: Schema.optionalKey(Schema.String),
  credits: Schema.optionalKey(
    Schema.Struct({
      balance: Schema.optionalKey(Schema.Number)
    })
  )
})

type RawWindow = typeof RawWindow.Type
type WindowKind = "short" | "weekly"

interface ParsedWindow {
  readonly kind: WindowKind
  readonly window: UsageWindow
}

export class CodexUsageParseError extends Schema.TaggedErrorClass<CodexUsageParseError>()(
  "CodexUsageParseError",
  {
    message: Schema.String
  }
) {}

const failure = () =>
  new CodexUsageParseError({
    message: "The Codex usage response has an unsupported shape"
  })

const normalizeReset = (value: number | undefined): number | undefined => {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined
  }
  return Math.trunc(value < 1_000_000_000_000 ? value * 1_000 : value)
}

const classifyWindow = (raw: RawWindow, fallback: WindowKind): WindowKind => {
  const seconds =
    raw.limit_window_seconds ??
    (raw.windowDurationMins === undefined ? undefined : raw.windowDurationMins * 60)
  if (seconds === undefined) {
    return fallback
  }
  if (!Number.isFinite(seconds)) {
    throw failure()
  }
  if (seconds === shortWindowSeconds) {
    return "short"
  }
  if (seconds === weeklyWindowSeconds) {
    return "weekly"
  }
  throw failure()
}

const parseWindow = (
  raw: RawWindow | undefined,
  fallback: WindowKind
): ParsedWindow | undefined => {
  if (raw === undefined) {
    return undefined
  }
  const usedPercent = raw.used_percent ?? raw.usedPercent
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) {
    throw failure()
  }
  const resetAt = normalizeReset(raw.reset_at ?? raw.resetsAt)
  return {
    kind: classifyWindow(raw, fallback),
    window: UsageWindow.make({
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      ...(resetAt === undefined ? {} : { resetAt })
    })
  }
}

const exactlyOne = (
  windows: ReadonlyArray<ParsedWindow>,
  kind: WindowKind
): UsageWindow | undefined => {
  const matches = windows.filter((window) => window.kind === kind)
  if (matches.length !== 1) {
    return undefined
  }
  return matches[0]?.window
}

const decodeRawUsage = Schema.decodeUnknownEffect(RawUsage)

export const decodeCodexUsage = Effect.fn("decodeCodexUsage")(function* (
  input: unknown,
  observedAt: number,
  accountId: AccountIdType
) {
  const raw = yield* decodeRawUsage(input).pipe(Effect.mapError(failure))
  const rateLimit = raw.rate_limit ?? raw.rateLimit
  if (rateLimit === undefined) {
    return yield* failure()
  }

  const parsed = yield* Effect.try({
    try: () => {
      const windows = [
        parseWindow(rateLimit.primary_window ?? rateLimit.primary, "short"),
        parseWindow(rateLimit.secondary_window ?? rateLimit.secondary, "weekly")
      ].filter((window): window is ParsedWindow => window !== undefined)
      const short = exactlyOne(windows, "short")
      const weekly = exactlyOne(windows, "weekly")
      if (short === undefined || weekly === undefined) {
        throw failure()
      }
      return { short, weekly }
    },
    catch: failure
  })

  const credits =
    raw.credits?.balance === undefined || !Number.isFinite(raw.credits.balance)
      ? undefined
      : Math.max(0, raw.credits.balance)
  const planType = raw.plan_type ?? raw.planType
  return UsageSnapshot.make({
    accountId: AccountId.make(accountId),
    observedAt,
    short: parsed.short,
    stale: false,
    weekly: parsed.weekly,
    ...(credits === undefined ? {} : { credits }),
    ...(planType === undefined ? {} : { planType })
  })
})
