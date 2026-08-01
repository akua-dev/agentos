import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { AgentIdentity, IdentityDirectory } from "./foundation.ts"

const Ada = AgentIdentity.make({
  id: "agent_ada",
  role: "crewmate"
})

layer(IdentityDirectory.test(new Map([[Ada.id, Ada]])))("Effect service testing reference", (it) => {
  it.effect("provides deterministic service Layers", () =>
    Effect.gen(function*() {
      const directory = yield* IdentityDirectory
      const identity = yield* directory.find(Ada.id)
      assert.deepStrictEqual(identity, Ada)
    }))

  it.effect("asserts typed failure channels", () =>
    Effect.gen(function*() {
      const directory = yield* IdentityDirectory
      const error = yield* Effect.flip(directory.find("missing"))
      assert.strictEqual(error._tag, "IdentityLookupError")
      assert.strictEqual(error.reason, "identity_not_found")
    }))
})
