import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import { classifyUpstreamResponse } from "../src/index.ts"

const now = Date.UTC(2026, 6, 30, 12)

describe("classifyUpstreamResponse", () => {
  it("keeps authentication, authorization, model, and server failures distinct", () => {
    expect(classifyUpstreamResponse(401, new Headers(), now).kind).toBe("reauth")
    expect(classifyUpstreamResponse(403, new Headers(), now).kind).toBe("forbidden")
    expect(classifyUpstreamResponse(404, new Headers(), now).kind).toBe("not_found")
    expect(classifyUpstreamResponse(503, new Headers(), now).kind).toBe("transient")
    expect(classifyUpstreamResponse(200, new Headers(), now).kind).toBe("success")
  })

  it("parses numeric Retry-After without confusing it with a provider reset timestamp", () => {
    const headers = new Headers({ "retry-after": "45" })
    const classification = classifyUpstreamResponse(429, headers, now)

    expect(classification.kind).toBe("quota")
    expect(Option.getOrUndefined(classification.retryAt)).toBe(now + 45_000)
  })

  it("parses HTTP-date Retry-After and ignores malformed values", () => {
    const retryAt = now + 60_000
    const dated = classifyUpstreamResponse(
      429,
      new Headers({ "retry-after": new Date(retryAt).toUTCString() }),
      now
    )
    const malformed = classifyUpstreamResponse(
      429,
      new Headers({ "retry-after": "not-a-date" }),
      now
    )

    expect(Option.getOrUndefined(dated.retryAt)).toBe(retryAt)
    expect(Option.isNone(malformed.retryAt)).toBe(true)
  })
})
