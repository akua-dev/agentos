import { expect, layer } from "@effect/vitest"
import { MaintenanceResult, SubscriptionRouter } from "@akua-dev/codex-router-codex"
import { Duration, Effect, Layer, Schedule } from "effect"
import { bunMaintenanceSchedule, runBunMaintenanceIteration } from "../src/index.ts"

const probe = { calls: 0 }

const maintenanceLayer = Layer.succeed(
  SubscriptionRouter,
  SubscriptionRouter.of({
    acquire: () => Effect.die("not used"),
    maintain: () =>
      Effect.sync(() => {
        probe.calls += 1
        return MaintenanceResult.make({ ready: probe.calls, visited: probe.calls })
      }),
    recordResponse: () => Effect.void,
    release: () => Effect.void,
    renew: () => Effect.succeed(true)
  })
)

layer(maintenanceLayer)("Bun maintenance schedule", (it) => {
  it.effect("runs the portable maintenance operation on a one-minute Effect schedule", () =>
    Effect.gen(function* () {
      probe.calls = 0
      yield* runBunMaintenanceIteration()
      expect(probe.calls).toBe(1)

      const step = yield* Schedule.toStep(bunMaintenanceSchedule)
      const [, delay] = yield* step(0, undefined)
      expect(Duration.toMillis(delay)).toBe(60_000)
    })
  )
})
