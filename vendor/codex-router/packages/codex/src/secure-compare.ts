import { Crypto, Effect } from "effect"

const textEncoder = new TextEncoder()

const fixedLengthEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

export const secureCompare = Effect.fn("secureCompare")(function* (
  actual: string,
  expected: string
) {
  const crypto = yield* Crypto.Crypto
  const actualDigest = yield* crypto.digest("SHA-256", textEncoder.encode(actual))
  const expectedDigest = yield* crypto.digest("SHA-256", textEncoder.encode(expected))
  return fixedLengthEqual(actualDigest, expectedDigest)
})
