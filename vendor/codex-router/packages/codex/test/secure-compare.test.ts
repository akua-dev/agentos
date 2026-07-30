import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Layer } from "effect"
import { secureCompare } from "../src/secure-compare.ts"

const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    digest: (_algorithm, data) => {
      const digest = new Uint8Array(32)
      for (let index = 0; index < data.length; index += 1) {
        const digestIndex = index % digest.length
        digest[digestIndex] = (digest[digestIndex] ?? 0) ^ (data[index] ?? 0)
      }
      digest[31] = (digest[31] ?? 0) ^ data.length
      return Effect.succeed(digest)
    },
    randomBytes: (size) => new Uint8Array(size)
  })
)

describe("secureCompare", () => {
  it.effect("compares fixed-length digests for equal, unequal, and differently sized secrets", () =>
    Effect.gen(function* () {
      expect(yield* secureCompare("same-secret", "same-secret")).toBe(true)
      expect(yield* secureCompare("same-secret", "other-secret")).toBe(false)
      expect(yield* secureCompare("", "a-secret-with-an-entirely-different-length")).toBe(false)
    }).pipe(Effect.provide(cryptoLayer))
  )
})
