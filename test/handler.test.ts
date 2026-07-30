import { expect, layer } from "@effect/vitest"
import {
  AccountId,
  Candidate,
  RoutingState,
  RoutingStateError,
  UsageSnapshot,
  UsageWindow,
  defaultRoutingConfig,
  inMemoryRoutingStateLayer
} from "@akua-dev/codex-router-core"
import { Effect, Layer, Redacted } from "effect"
import {
  AccountCredential,
  AccountDirectory,
  ClientAuthenticator,
  GatewayTelemetry,
  TransportError,
  UpstreamTransport,
  extractSessionKey,
  makeRouterFetch,
  resolveUpstreamTarget,
  supportedResponsePaths
} from "../src/index.ts"

const now = Date.UTC(2026, 6, 30, 12)
const accountId = AccountId.make("account-a")
const candidate = Candidate.make({
  accountId,
  activeReservations: 0,
  requiresReauthentication: false,
  usage: UsageSnapshot.make({
    accountId,
    observedAt: now,
    short: UsageWindow.make({
      resetAt: now + 60 * 60 * 1_000,
      usedPercent: 10
    }),
    weekly: UsageWindow.make({
      resetAt: now + 7 * 24 * 60 * 60 * 1_000,
      usedPercent: 10
    })
  })
})

interface Probe {
  readonly requests: Array<Request>
  bookkeepingFailures: number
}

interface TestLayerOptions {
  readonly authorized?: boolean
  readonly accountKind?: "codex_subscription" | "openai_api_key"
  readonly response?: () => Response
  readonly transportFailure?: boolean
  readonly bookkeepingFailure?: boolean
}

const makeTestLayer = (probe: Probe, options: TestLayerOptions = {}) => {
  const routing = options.bookkeepingFailure
    ? Layer.effect(
        RoutingState,
        Effect.gen(function* () {
          const state = yield* RoutingState
          return RoutingState.of({
            ...state,
            recordResponse: () =>
              Effect.fail(
                new RoutingStateError({
                  message: "bookkeeping failed"
                })
              )
          })
        })
      ).pipe(Layer.provide(inMemoryRoutingStateLayer(defaultRoutingConfig)))
    : inMemoryRoutingStateLayer(defaultRoutingConfig)

  return Layer.mergeAll(
    routing,
    Layer.succeed(
      ClientAuthenticator,
      ClientAuthenticator.of({
        authenticate: () => Effect.succeed(options.authorized ?? true)
      })
    ),
    Layer.succeed(
      AccountDirectory,
      AccountDirectory.of({
        candidates: Effect.succeed([candidate]),
        credential: () =>
          Effect.succeed(
            AccountCredential.make({
              accessToken: Redacted.make("selected-secret"),
              accountId,
              kind: options.accountKind ?? "codex_subscription",
              providerAccountId: "provider-account-a"
            })
          )
      })
    ),
    Layer.succeed(
      UpstreamTransport,
      UpstreamTransport.of({
        execute: (request) => {
          probe.requests.push(request)
          return options.transportFailure
            ? Effect.fail(new TransportError({ message: "transport failed" }))
            : Effect.succeed(
                options.response?.() ??
                  new Response(null, {
                    headers: { "x-upstream": "yes" },
                    status: 204
                  })
              )
        }
      })
    ),
    Layer.succeed(
      GatewayTelemetry,
      GatewayTelemetry.of({
        bookkeepingFailure: () =>
          Effect.sync(() => {
            probe.bookkeepingFailures += 1
          }),
        decision: () => Effect.void
      })
    )
  )
}

const makeProbe = (): Probe => ({
  bookkeepingFailures: 0,
  requests: []
})

const post = (path: string, body = "{}", headers: HeadersInit = {}) =>
  new Request(`https://router.invalid${path}`, {
    body,
    headers,
    method: "POST"
  })

{
  const probe = makeProbe()
  layer(makeTestLayer(probe, { authorized: false }))("authentication boundary", (it) => {
    it.effect("rejects before pulling a streamed request body", () =>
      Effect.gen(function* () {
        let bodyWasPulled = false
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              bodyWasPulled = true
              controller.enqueue(new TextEncoder().encode("{}"))
              controller.close()
            }
          },
          { highWaterMark: 0 }
        )
        const fetch = yield* makeRouterFetch()
        const init: RequestInit & { readonly duplex: "half" } = {
          body,
          duplex: "half",
          method: "POST"
        }
        const response = yield* Effect.promise(() =>
          fetch(new Request("https://router.invalid/responses", init))
        )

        expect(response.status).toBe(401)
        expect(bodyWasPulled).toBe(false)
        expect(probe.requests).toHaveLength(0)
      })
    )
  })
}

{
  const probe = makeProbe()
  const chunks = [
    new Uint8Array([0, 255, 1, 2]),
    new TextEncoder().encode('data: {"type":"response.completed"}\n\n')
  ]
  layer(
    makeTestLayer(probe, {
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(chunk)
              }
              controller.close()
            }
          }),
          {
            headers: {
              connection: "keep-alive",
              "content-encoding": "gzip",
              "content-length": "999",
              "content-type": "text/event-stream",
              "x-upstream": "preserved"
            },
            status: 201,
            statusText: "Created"
          }
        )
    })
  )("transparent forwarding", (it) => {
    it.effect("supports every Responses path and preserves opaque streamed bytes", () =>
      Effect.gen(function* () {
        const fetch = yield* makeRouterFetch()
        for (const path of supportedResponsePaths) {
          const response = yield* Effect.promise(() =>
            fetch(
              post(path, '{"compaction_trigger":123}', {
                authorization: "Bearer caller-secret",
                "chatgpt-account-id": "caller-account",
                "session-id": "session-a",
                "x-api-key": "caller-api-key"
              })
            )
          )
          const bytes = new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))

          expect(response.status).toBe(201)
          expect(response.statusText).toBe("Created")
          expect(response.headers.get("x-upstream")).toBe("preserved")
          expect(response.headers.has("content-encoding")).toBe(false)
          expect(response.headers.has("content-length")).toBe(false)
          expect(bytes).toEqual(new Uint8Array([...chunks[0]!, ...chunks[1]!]))
        }

        expect(probe.requests).toHaveLength(supportedResponsePaths.length)
        for (const request of probe.requests) {
          expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses")
          expect(request.headers.get("authorization")).toBe("Bearer selected-secret")
          expect(request.headers.get("chatgpt-account-id")).toBe("provider-account-a")
          expect(request.headers.has("x-api-key")).toBe(false)
          expect(request.headers.get("session-id")).toBe("session-a")
        }
      })
    )
  })
}

{
  const probe = makeProbe()
  layer(makeTestLayer(probe))("router-owned errors", (it) => {
    it.effect("rejects unsupported methods, paths, and overlong explicit sessions", () =>
      Effect.gen(function* () {
        const fetch = yield* makeRouterFetch()
        const wrongMethod = yield* Effect.promise(() =>
          fetch(new Request("https://router.invalid/responses"))
        )
        const wrongPath = yield* Effect.promise(() => fetch(post("/chat/completions")))
        const longSession = yield* Effect.promise(() =>
          fetch(post("/responses", "{}", { "x-codex-router-session": "x".repeat(257) }))
        )

        expect(wrongMethod.status).toBe(404)
        expect(wrongPath.status).toBe(404)
        expect(longSession.status).toBe(400)
        expect(probe.requests).toHaveLength(0)
      })
    )
  })
}

{
  const probe = makeProbe()
  layer(makeTestLayer(probe, { transportFailure: true }))("transport failure", (it) => {
    it.effect("releases the lease and returns a gateway error before any response", () =>
      Effect.gen(function* () {
        const fetch = yield* makeRouterFetch()
        const response = yield* Effect.promise(() => fetch(post("/responses")))
        const state = yield* RoutingState
        const summary = yield* state.summary(Date.now())

        expect(response.status).toBe(502)
        expect(summary.activeReservations).toBe(0)
      })
    )
  })
}

{
  const probe = makeProbe()
  layer(
    makeTestLayer(probe, {
      bookkeepingFailure: true,
      response: () => new Response("real upstream", { status: 418 })
    })
  )("bookkeeping isolation", (it) => {
    it.effect("never replaces a real upstream response with bookkeeping failure", () =>
      Effect.gen(function* () {
        const fetch = yield* makeRouterFetch()
        const response = yield* Effect.promise(() => fetch(post("/responses")))

        expect(response.status).toBe(418)
        expect(yield* Effect.promise(() => response.text())).toBe("real upstream")
        expect(probe.bookkeepingFailures).toBe(1)
      })
    )
  })
}

{
  const probe = makeProbe()
  let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined
  layer(
    makeTestLayer(probe, {
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstreamController = controller
            }
          })
        )
    })
  )("stream cancellation", (it) => {
    it.effect("releases the lease when the downstream cancels", () =>
      Effect.gen(function* () {
        const fetch = yield* makeRouterFetch()
        const response = yield* Effect.promise(() => fetch(post("/responses")))
        const body = response.body
        expect(body).not.toBeNull()
        if (body === null) {
          return
        }
        yield* Effect.promise(() => body.cancel("caller cancelled"))
        const state = yield* RoutingState
        const summary = yield* state.summary(Date.now())

        expect(summary.activeReservations).toBe(0)
        expect(upstreamController).toBeDefined()
      })
    )
  })
}

layer(makeTestLayer(makeProbe(), { accountKind: "openai_api_key" }))("protocol helpers", (it) => {
  it.effect("extracts only explicit bounded sessions and maps API-key compact paths", () =>
    Effect.gen(function* () {
      const session = yield* extractSessionKey(
        new Headers({ "x-codex-parent-thread-id": " thread-1 " })
      )

      expect(session.valueOrUndefined).toBe("thread-1")
      expect(resolveUpstreamTarget("/v1/responses/compact", "openai_api_key")).toBe(
        "https://api.openai.com/v1/responses/compact"
      )
      expect(resolveUpstreamTarget("/codex/responses", "openai_api_key")).toBe(
        "https://api.openai.com/v1/responses"
      )
    })
  )
})
