import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpEffect } from "effect/unstable/http"
import { makeRawWebHandler } from "../src/index.ts"

it.effect("preserves a raw Web response object at the Effect HTTP boundary", () =>
  Effect.gen(function* () {
    const original = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 255, 1]))
          controller.close()
        }
      }),
      {
        headers: { "x-raw-response": "preserved" },
        status: 201,
        statusText: "Created"
      }
    )
    const handler = makeRawWebHandler(() => Effect.succeed(original))
    const response = yield* Effect.promise(() =>
      HttpEffect.toWebHandler(handler)(new Request("https://router.invalid/responses"))
    )

    expect(response).toBe(original)
    expect(response.statusText).toBe("Created")
    expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(
      new Uint8Array([0, 255, 1])
    )
  })
)
