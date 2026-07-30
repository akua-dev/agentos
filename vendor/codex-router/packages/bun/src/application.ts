import {
  AccountAdmin,
  AccountDirectory,
  AdminAuthenticator,
  ClientAuthenticator,
  GatewayTelemetry,
  UpstreamTransport,
  type RouterFetch
} from "@akua-dev/codex-router-codex"
import { RoutingState } from "@akua-dev/codex-router-core"
import { ManagedRuntime } from "effect"
import type { BunRuntimeConfig } from "./config.ts"
import { bunRuntimeLayer } from "./layers.ts"
import { makeBunFetch } from "./server.ts"

export interface BunApplication {
  readonly fetch: RouterFetch
  readonly close: () => Promise<void>
}

export const makeBunApplication = async (config: BunRuntimeConfig): Promise<BunApplication> => {
  const runtime = ManagedRuntime.make(bunRuntimeLayer(config))
  try {
    const fetch = await runtime.runPromise(makeBunFetch())
    return {
      close: runtime.dispose,
      fetch
    }
  } catch (error) {
    await runtime.dispose()
    throw error
  }
}

export type BunRuntimeServices =
  | RoutingState
  | ClientAuthenticator
  | AdminAuthenticator
  | AccountAdmin
  | AccountDirectory
  | UpstreamTransport
  | GatewayTelemetry
