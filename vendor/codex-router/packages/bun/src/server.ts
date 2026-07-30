import { RoutingState } from "@akua-dev/codex-router-core"
import {
  ClientAuthenticator,
  makeAccountAdminHttpHandler,
  makeRawWebHandler,
  makeRouterHttpHandler
} from "@akua-dev/codex-router-codex"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import { Clock, Effect, Option, Result } from "effect"
import * as Layer from "effect/Layer"
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import type { BunRuntimeConfig } from "./config.ts"
import { bunRuntimeLayer } from "./layers.ts"

const statusResponse = Effect.fn("bunStatusResponse")(function* (
  request: Request,
  authenticator: ClientAuthenticator["Service"],
  routingState: RoutingState["Service"]
) {
  const authentication = yield* Effect.result(authenticator.authenticate(request))
  if (Result.isFailure(authentication) || !authentication.success) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  const now = yield* Clock.currentTimeMillis
  const summary = yield* Effect.result(routingState.summary(now))
  if (Result.isFailure(summary)) {
    return Response.json({ error: "routing_state_unavailable" }, { status: 503 })
  }
  return Response.json({
    accounts: summary.success.accounts.map((account) => ({
      accountId: account.accountId,
      activeReservations: account.activeReservations,
      blockKind: Option.getOrNull(account.blockKind),
      requiresReauthentication: account.requiresReauthentication
    })),
    activeReservations: summary.success.activeReservations,
    assignments: summary.success.assignments
  })
})

export const makeBunFetch = Effect.fn("makeBunFetch")(function* () {
  const routerHandler = yield* makeRouterHttpHandler()
  const adminHandler = yield* makeAccountAdminHttpHandler()
  const authenticator = yield* ClientAuthenticator
  const routingState = yield* RoutingState
  const router = yield* HttpRouter.make

  yield* router.add("GET", "/healthz", HttpServerResponse.jsonUnsafe({ status: "ok" }))
  yield* router.add(
    "GET",
    "/status",
    makeRawWebHandler((request) => statusResponse(request, authenticator, routingState))
  )
  yield* router.add("*", "/admin/*", adminHandler)
  yield* router.add("*", "/*", routerHandler)

  return HttpEffect.toWebHandler(router.asHttpEffect())
})

const makeBunHttpRoutes = Effect.fn("makeBunHttpRoutes")(function* () {
  const routerHandler = yield* makeRouterHttpHandler()
  const adminHandler = yield* makeAccountAdminHttpHandler()
  const authenticator = yield* ClientAuthenticator
  const routingState = yield* RoutingState

  return Layer.mergeAll(
    HttpRouter.add("GET", "/healthz", HttpServerResponse.jsonUnsafe({ status: "ok" })),
    HttpRouter.add(
      "GET",
      "/status",
      makeRawWebHandler((request) => statusResponse(request, authenticator, routingState))
    ),
    HttpRouter.add("*", "/admin/*", adminHandler),
    HttpRouter.add("*", "/*", routerHandler)
  )
})

export const bunHttpRoutes = Layer.unwrap(makeBunHttpRoutes())

export interface BunServerLayerOptions {
  readonly idleTimeout?: number
  readonly maintenance?: boolean
}

export const bunServerLayer = (config: BunRuntimeConfig, options: BunServerLayerOptions = {}) => {
  const runtime = bunRuntimeLayer(
    config,
    options.maintenance === undefined ? {} : { maintenance: options.maintenance }
  )
  const server = BunHttpServer.layer({
    hostname: config.hostname,
    ...(options.idleTimeout === undefined ? {} : { idleTimeout: options.idleTimeout }),
    port: config.port
  })
  const infrastructure = Layer.merge(runtime, server)
  const served = HttpRouter.serve(bunHttpRoutes, {
    disableListenLog: false,
    disableLogger: false
  }).pipe(Layer.provide(infrastructure))
  return Layer.merge(infrastructure, served)
}
