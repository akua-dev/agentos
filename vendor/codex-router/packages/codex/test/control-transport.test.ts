import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { makeHttpClientCodexControlTransport } from "../src/index.ts"

describe("Codex control transport", () => {
  it.effect("executes through the supplied Effect HttpClient", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly method: string; readonly url: string }> = []
      const client = HttpClient.make((request) => {
        requests.push({ method: request.method, url: String(request.url) })
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ status: "ok" })))
      })
      const transport = makeHttpClientCodexControlTransport(client)

      const response = yield* transport.execute(
        new Request("https://control.example.test/quota", { method: "POST" })
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ status: "ok" })
      expect(requests).toEqual([{ method: "POST", url: "https://control.example.test/quota" }])
    })
  )
})
