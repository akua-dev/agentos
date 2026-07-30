import { SubscriptionRouter } from "@akua-dev/codex-router-codex"
import { Clock, Effect, Layer, Schedule } from "effect"

export const runBunMaintenanceIteration = Effect.fn("BunSubscriptionMaintenance.maintainOnce")(
  function* () {
    const router = yield* SubscriptionRouter
    const now = yield* Clock.currentTimeMillis
    yield* router.maintain(now).pipe(
      Effect.tap((result) =>
        Effect.logDebug("subscription maintenance completed").pipe(
          Effect.annotateLogs({
            ready: result.ready,
            runtime: "bun",
            visited: result.visited
          })
        )
      ),
      Effect.catch((error) =>
        Effect.logWarning("subscription maintenance failed", error).pipe(
          Effect.annotateLogs({ runtime: "bun" })
        )
      )
    )
  }
)

export const bunMaintenanceSchedule = Schedule.spaced("1 minute")

export const runBunMaintenanceWithSchedule = (schedule: Schedule.Schedule<unknown, unknown>) =>
  runBunMaintenanceIteration().pipe(Effect.repeat(schedule))

export const runBunMaintenance = runBunMaintenanceWithSchedule(bunMaintenanceSchedule)

export const bunMaintenanceLayer = Layer.effectDiscard(runBunMaintenance.pipe(Effect.forkScoped))
