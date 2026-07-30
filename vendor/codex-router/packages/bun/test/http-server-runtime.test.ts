import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { expect, test } from "bun:test"
import { Context, Effect, Exit, FileSystem, Layer, Redacted, Scope } from "effect"
import { HttpServer } from "effect/unstable/http"
import { BunRuntimeConfig, bunServerLayer } from "../src/index.ts"

test("acquires, serves, and finalizes the official Bun HTTP server layer", async () => {
  await Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const originalServe = Bun.serve
        let reloads = 0
        let stops = 0
        const fakeServer = {
          hostname: "127.0.0.1",
          port: 43123,
          reload: () => {
            reloads += 1
            return fakeServer
          },
          stop: () => {
            stops += 1
            return Promise.resolve()
          }
        }
        Bun.serve = (() => fakeServer) as unknown as typeof Bun.serve
        return {
          fakeServer,
          originalServe,
          reloads: () => reloads,
          stops: () => stops
        }
      }),
      (probe) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "codex-router-http-"
          })
          const config = BunRuntimeConfig.make({
            accounts: [],
            adminToken: Redacted.make("admin-secret"),
            clientToken: Redacted.make("client-secret"),
            databasePath: `${directory}/router.sqlite`,
            hostname: "127.0.0.1",
            port: 0
          })
          const scope = yield* Scope.make()
          const context = yield* Layer.buildWithScope(
            bunServerLayer(config, { maintenance: false }),
            scope
          )
          const server = Context.get(context, HttpServer.HttpServer)

          expect(server.address).toEqual({
            _tag: "TcpAddress",
            hostname: "127.0.0.1",
            port: 43123
          })
          expect(probe.reloads()).toBeGreaterThan(0)

          yield* Scope.close(scope, Exit.void)
          expect(probe.stops()).toBeGreaterThan(0)
        }),
      (probe) =>
        Effect.sync(() => {
          Bun.serve = probe.originalServe
        })
    ).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer))
  )
})
