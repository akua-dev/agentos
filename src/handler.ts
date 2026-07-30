import {
  RoutingState,
  classifyUpstreamResponse,
  type LeaseToken,
  type RouteLease
} from "@akua-dev/codex-router-core"
import { Effect, Option, Result } from "effect"
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from "./headers.ts"
import { isSupportedResponsePath, resolveUpstreamTarget } from "./protocol.ts"
import {
  AccountDirectory,
  ClientAuthenticator,
  GatewayTelemetry,
  UpstreamTransport,
  type AccountCredential
} from "./services.ts"
import { extractSessionKey } from "./session.ts"

export type RouterFetch = (request: Request) => Promise<Response>

const jsonResponse = (status: number, error: string): Response =>
  Response.json({ error }, { status })

const releaseIgnoringFailure = (state: RoutingState["Service"], leaseToken: LeaseToken) =>
  state.release(leaseToken).pipe(Effect.catchCause(() => Effect.void))

interface StreamingRequestInit extends RequestInit {
  readonly duplex: "half"
}

const makeUpstreamRequest = (
  original: Request,
  path: string,
  credential: AccountCredential
): Effect.Effect<Request> =>
  Effect.sync(() => {
    const headers = sanitizeRequestHeaders(original.headers)
    headers.set("authorization", credential.authorization)
    if (credential.kind === "codex_subscription" && credential.providerAccountId !== undefined) {
      headers.set("chatgpt-account-id", credential.providerAccountId)
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
    return new Request(resolveUpstreamTarget(path, credential.kind), init)
  })

const streamWithLease = (
  body: ReadableStream<Uint8Array>,
  state: RoutingState["Service"],
  lease: RouteLease
): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  let finishPromise: Promise<void> | undefined
  let nextRenewAt = Date.now() + 40_000
  const finish = (): Promise<void> => {
    if (finishPromise === undefined) {
      finishPromise = Effect.runPromise(releaseIgnoringFailure(state, lease.leaseToken))
    }
    return finishPromise
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const now = Date.now()
        if (now >= nextRenewAt) {
          nextRenewAt = now + 40_000
          await Effect.runPromise(
            state.renew(lease.leaseToken, now).pipe(Effect.catchCause(() => Effect.succeed(false)))
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
  readonly directory: AccountDirectory["Service"]
  readonly state: RoutingState["Service"]
  readonly telemetry: GatewayTelemetry["Service"]
  readonly transport: UpstreamTransport["Service"]
}

const routeRequest = Effect.fn("routeRequest")(function* (
  request: Request,
  dependencies: RouteDependencies
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

  const candidates = yield* Effect.result(dependencies.directory.candidates)
  if (Result.isFailure(candidates)) {
    return jsonResponse(503, "account_directory_unavailable")
  }
  const leaseResult = yield* Effect.result(
    dependencies.state.acquire({
      candidates: candidates.success,
      now: Date.now(),
      ...(Option.isNone(sessionKey) ? {} : { sessionKey: sessionKey.value })
    })
  )
  if (Result.isFailure(leaseResult) || Option.isNone(leaseResult.success)) {
    return jsonResponse(503, "no_eligible_account")
  }
  const lease = leaseResult.success.value

  const credentialResult = yield* Effect.result(dependencies.directory.credential(lease.accountId))
  if (Result.isFailure(credentialResult)) {
    yield* releaseIgnoringFailure(dependencies.state, lease.leaseToken)
    return jsonResponse(503, "credential_unavailable")
  }

  yield* dependencies.telemetry
    .decision({
      accountId: lease.accountId,
      reason: "best_candidate",
      sessionKey
    })
    .pipe(Effect.catchCause(() => Effect.void))

  const upstreamRequest = yield* Effect.result(
    makeUpstreamRequest(request, url.pathname, credentialResult.success)
  )
  if (Result.isFailure(upstreamRequest)) {
    yield* releaseIgnoringFailure(dependencies.state, lease.leaseToken)
    return jsonResponse(400, "invalid_request")
  }
  const upstreamResult = yield* Effect.result(
    dependencies.transport.execute(upstreamRequest.success)
  )
  if (Result.isFailure(upstreamResult)) {
    yield* releaseIgnoringFailure(dependencies.state, lease.leaseToken)
    return jsonResponse(502, "upstream_unavailable")
  }
  const upstream = upstreamResult.success
  const classification = classifyUpstreamResponse(upstream.status, upstream.headers, Date.now())
  yield* dependencies.state.recordResponse(lease.accountId, classification, Date.now()).pipe(
    Effect.catchCause(() =>
      dependencies.telemetry.bookkeepingFailure({
        accountId: lease.accountId,
        operation: "record_response"
      })
    )
  )

  const headers = sanitizeResponseHeaders(upstream.headers)
  if (upstream.body === null) {
    yield* releaseIgnoringFailure(dependencies.state, lease.leaseToken)
    return new Response(null, {
      headers,
      status: upstream.status,
      statusText: upstream.statusText
    })
  }
  return new Response(streamWithLease(upstream.body, dependencies.state, lease), {
    headers,
    status: upstream.status,
    statusText: upstream.statusText
  })
})

export const makeRouterFetch = Effect.fn("makeRouterFetch")(function* () {
  const authenticator = yield* ClientAuthenticator
  const directory = yield* AccountDirectory
  const state = yield* RoutingState
  const telemetry = yield* GatewayTelemetry
  const transport = yield* UpstreamTransport
  const dependencies: RouteDependencies = {
    authenticator,
    directory,
    state,
    telemetry,
    transport
  }

  return (request: Request): Promise<Response> =>
    Effect.runPromise(
      routeRequest(request, dependencies).pipe(
        Effect.catchCause(() => Effect.succeed(jsonResponse(500, "internal_error")))
      )
    )
})
