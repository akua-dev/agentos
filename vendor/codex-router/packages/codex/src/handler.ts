import {
  classifyUpstreamResponse,
  type LeaseToken,
  type RouteLease
} from "@akua-dev/codex-router-core"
import { Clock, Effect, Option, Redacted, Result } from "effect"
import { HttpEffect } from "effect/unstable/http"
import type { SubscriptionCredential } from "./credentials.ts"
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from "./headers.ts"
import { makeRawWebHandler } from "./http-application.ts"
import { isSupportedResponsePath, resolveUpstreamTarget } from "./protocol.ts"
import { ClientAuthenticator, GatewayTelemetry, UpstreamTransport } from "./services.ts"
import { extractSessionKey } from "./session.ts"
import { SubscriptionRouter } from "./subscription-router.ts"

export type RouterFetch = (request: Request) => Promise<Response>

const jsonResponse = (status: number, error: string): Response =>
  Response.json({ error }, { status })

const releaseIgnoringFailure = (router: SubscriptionRouter["Service"], leaseToken: LeaseToken) =>
  router.release(leaseToken).pipe(Effect.catchCause(() => Effect.void))

interface StreamingRequestInit extends RequestInit {
  readonly duplex: "half"
}

const makeUpstreamRequest = (
  original: Request,
  path: string,
  credential: SubscriptionCredential
): Effect.Effect<Request> =>
  Effect.sync(() => {
    const headers = sanitizeRequestHeaders(original.headers)
    headers.set("authorization", credential.authorization)
    if (credential.providerAccountId !== undefined) {
      headers.set("chatgpt-account-id", Redacted.value(credential.providerAccountId))
    } else {
      headers.delete("chatgpt-account-id")
    }
    const init: StreamingRequestInit = {
      body: original.body,
      duplex: "half",
      headers,
      method: "POST",
      signal: original.signal
    }
    return new Request(resolveUpstreamTarget(path), init)
  })

const streamWithLease = (
  body: ReadableStream<Uint8Array>,
  router: SubscriptionRouter["Service"],
  lease: RouteLease,
  initialNow: number,
  runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  let finishPromise: Promise<void> | undefined
  let nextRenewAt = initialNow + 40_000
  const finish = (): Promise<void> => {
    if (finishPromise === undefined) {
      finishPromise = runPromise(releaseIgnoringFailure(router, lease.leaseToken))
    }
    return finishPromise
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const now = await runPromise(Clock.currentTimeMillis)
        if (now >= nextRenewAt) {
          nextRenewAt = now + 40_000
          await runPromise(
            router.renew(lease.leaseToken, now).pipe(Effect.catchCause(() => Effect.succeed(false)))
          )
        }
        const next = await reader.read()
        if (next.done) {
          await finish()
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        await finish()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        await finish()
      }
    }
  })
}

interface RouteDependencies {
  readonly authenticator: ClientAuthenticator["Service"]
  readonly router: SubscriptionRouter["Service"]
  readonly telemetry: GatewayTelemetry["Service"]
  readonly transport: UpstreamTransport["Service"]
}

const routeRequest = Effect.fn("routeRequest")(function* (
  request: Request,
  dependencies: RouteDependencies,
  runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
) {
  const authentication = yield* Effect.result(dependencies.authenticator.authenticate(request))
  if (Result.isFailure(authentication)) {
    return jsonResponse(500, "authentication_unavailable")
  }
  if (!authentication.success) {
    return jsonResponse(401, "unauthorized")
  }

  const url = new URL(request.url)
  if (request.method !== "POST" || !isSupportedResponsePath(url.pathname)) {
    return jsonResponse(404, "not_found")
  }

  const sessionResult = yield* Effect.result(extractSessionKey(request.headers))
  if (Result.isFailure(sessionResult)) {
    return jsonResponse(400, "invalid_session")
  }
  const sessionKey = sessionResult.success

  const now = yield* Clock.currentTimeMillis
  const grantResult = yield* Effect.result(
    dependencies.router.acquire({
      now,
      ...(Option.isNone(sessionKey) ? {} : { sessionKey: sessionKey.value })
    })
  )
  if (Result.isFailure(grantResult) || Option.isNone(grantResult.success)) {
    return jsonResponse(503, "no_eligible_account")
  }
  const grant = grantResult.success.value
  const lease = grant.lease
  const credential = grant.credential

  yield* dependencies.telemetry
    .decision({
      accountId: lease.accountId,
      reason: "best_candidate",
      sessionKey
    })
    .pipe(Effect.catchCause(() => Effect.void))

  const upstreamRequest = yield* Effect.result(
    makeUpstreamRequest(request, url.pathname, credential)
  )
  if (Result.isFailure(upstreamRequest)) {
    yield* releaseIgnoringFailure(dependencies.router, lease.leaseToken)
    return jsonResponse(400, "invalid_request")
  }
  const upstreamResult = yield* Effect.result(
    dependencies.transport.execute(upstreamRequest.success)
  )
  if (Result.isFailure(upstreamResult)) {
    yield* releaseIgnoringFailure(dependencies.router, lease.leaseToken)
    return jsonResponse(502, "upstream_unavailable")
  }
  const upstream = upstreamResult.success
  const responseNow = yield* Clock.currentTimeMillis
  const classification = classifyUpstreamResponse(upstream.status, upstream.headers, responseNow)
  yield* dependencies.router
    .recordResponse(lease.accountId, credential.generation, classification, responseNow)
    .pipe(
      Effect.catchCause(() =>
        dependencies.telemetry.bookkeepingFailure({
          accountId: lease.accountId,
          operation: "record_response"
        })
      )
    )

  const headers = sanitizeResponseHeaders(upstream.headers)
  if (upstream.body === null) {
    yield* releaseIgnoringFailure(dependencies.router, lease.leaseToken)
    return new Response(null, {
      headers,
      status: upstream.status,
      statusText: upstream.statusText
    })
  }
  return new Response(
    streamWithLease(upstream.body, dependencies.router, lease, responseNow, runPromise),
    {
      headers,
      status: upstream.status,
      statusText: upstream.statusText
    }
  )
})

export const makeRouterHttpHandler = Effect.fn("makeRouterHttpHandler")(function* () {
  const authenticator = yield* ClientAuthenticator
  const router = yield* SubscriptionRouter
  const telemetry = yield* GatewayTelemetry
  const transport = yield* UpstreamTransport
  const context = yield* Effect.context<never>()
  const runPromise = Effect.runPromiseWith(context)
  const dependencies: RouteDependencies = {
    authenticator,
    router,
    telemetry,
    transport
  }

  return makeRawWebHandler((request) =>
    routeRequest(request, dependencies, runPromise).pipe(
      Effect.catchCause(() => Effect.succeed(jsonResponse(500, "internal_error")))
    )
  )
})

export const makeRouterFetch = Effect.fn("makeRouterFetch")(function* () {
  const handler = yield* makeRouterHttpHandler()
  return HttpEffect.toWebHandler(handler)
})
