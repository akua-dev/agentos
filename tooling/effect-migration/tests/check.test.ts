import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import { assert, layer } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { auditRepository } from "../check.ts"

const effectVersion = "4.0.0-beta.102"

interface FixtureOptions {
  readonly source?: string
  readonly status?: "planned" | "migrated" | "pure"
  readonly packageEffectVersion?: string
  readonly workspaceEffectVersion?: string
  readonly inventoryPattern?: string
  readonly addUnassignedFile?: boolean
  readonly exceptions?: ReadonlyArray<{
    readonly kind: string
    readonly path: string
    readonly rule: string
    readonly match: string
    readonly maximumOccurrences: number
    readonly reason: string
    readonly ownerIssue: number
    readonly test: string
    readonly removalCondition: string
    readonly expiresOn: string | null
  }>
}

const writeJson = Effect.fn("test.writeJson")(function*(path: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(path, `${JSON.stringify(value, null, 2)}\n`)
})

const makeFixture = Effect.fn("test.makeEffectMigrationFixture")(function*(options: FixtureOptions = {}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "agentos-effect-policy-" })
  yield* fs.makeDirectory(path.join(root, "src"), { recursive: true })
  yield* fs.makeDirectory(path.join(root, "tooling/effect-migration"), { recursive: true })

  yield* writeJson(path.join(root, "package.json"), {
    name: "fixture",
    private: true,
    devDependencies: {
      "@effect/opentelemetry": effectVersion,
      "@effect/platform-browser": effectVersion,
      "@effect/platform-bun": effectVersion,
      "@effect/sql-pg": effectVersion,
      "@effect/vitest": effectVersion,
      effect: effectVersion
    }
  })
  yield* writeJson(path.join(root, "tooling/effect-migration/policy.json"), {
    schemaVersion: 1,
    effectVersion,
    effectPackages: [
      "effect",
      "@effect/platform-browser",
      "@effect/platform-bun",
      "@effect/sql-pg",
      "@effect/opentelemetry",
      "@effect/vitest"
    ],
    ignoredDirectories: [".git", ".open-next", ".repos", "node_modules", "dist"],
    ignoredPaths: [],
    strictRules: [
      "no-async-function",
      "no-new-promise",
      "no-throw",
      "no-ambient-env",
      "no-runtime-execution",
      "no-raw-http",
      "no-raw-filesystem",
      "no-raw-process",
      "no-type-assertion",
      "no-untyped-json-parse",
      "no-native-timer"
    ]
  })
  yield* writeJson(path.join(root, "tooling/effect-migration/inventory.json"), {
    schemaVersion: 1,
    slices: [{
      id: "fixture",
      issue: 100,
      pattern: options.inventoryPattern ?? "^src/",
      runtime: "bun",
      package: "fixture",
      io: ["filesystem"],
      migrationDependencies: [],
      status: options.status ?? "migrated"
    }]
  })
  yield* writeJson(path.join(root, "tooling/effect-migration/exceptions.json"), {
    schemaVersion: 1,
    exceptions: options.exceptions ?? []
  })
  yield* fs.writeFileString(path.join(root, "src/example.ts"), options.source ?? "export const answer = 42\n")
  if (options.addUnassignedFile === true) {
    yield* fs.writeFileString(path.join(root, "orphan.ts"), "export const orphan = true\n")
  }

  if (options.packageEffectVersion !== undefined) {
    yield* writeJson(path.join(root, "package.json"), {
      name: "fixture",
      private: true,
      dependencies: { effect: options.packageEffectVersion },
      devDependencies: {
        "@effect/opentelemetry": effectVersion,
        "@effect/platform-browser": effectVersion,
        "@effect/platform-bun": effectVersion,
        "@effect/sql-pg": effectVersion,
        "@effect/vitest": effectVersion
      }
    })
  }
  if (options.workspaceEffectVersion !== undefined) {
    yield* fs.makeDirectory(path.join(root, "packages/child"), { recursive: true })
    yield* writeJson(path.join(root, "packages/child/package.json"), {
      name: "@fixture/child",
      private: true,
      dependencies: { effect: options.workspaceEffectVersion }
    })
  }
  return root
})

layer(Layer.merge(BunFileSystem.layer, BunPath.layer))("Effect migration policy", (it) => {
  it.effect("rejects planned inventory after final migration", () =>
    Effect.gen(function*() {
      const root = yield* makeFixture({ status: "planned" })
      const error = yield* Effect.flip(auditRepository(root))
      assert.strictEqual(error._tag, "MigrationPolicyReadError")
      assert.strictEqual(error.path, "tooling/effect-migration/inventory.json")
    }))

  it.effect("rejects legacy async in a migrated slice", () =>
    Effect.gen(function*() {
      const root = yield* makeFixture({
        status: "migrated",
        source: "export async function regressed() { return 1 }\n"
      })
      const report = yield* auditRepository(root)
      assert.include(report.violations.map((violation) => violation.rule), "no-async-function")
    }))

  it.effect("enforces every strict AST boundary in migrated code", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["no-new-promise", "export const value = new Promise(() => {})\n"],
        ["no-throw", "export function fail() { throw new Error(\"no\") }\n"],
        ["no-ambient-env", "export const value = process.env.VALUE\n"],
        ["no-runtime-execution", "import { Effect } from \"effect\"\nEffect.runPromise(Effect.void)\n"],
        ["no-raw-http", "export const value = fetch(\"https://example.test\")\n"],
        ["no-raw-http", "export const fetchImpl = fetch\n"],
        ["no-raw-http", "export const fetchImpl = globalThis.fetch\n"],
        ["no-raw-filesystem", "import { readFile } from \"node:fs\"\nexport { readFile }\n"],
        ["no-raw-process", "import { spawn } from \"node:child_process\"\nexport { spawn }\n"],
        ["no-type-assertion", "export const value = 1 as number\n"],
        ["no-untyped-json-parse", "export const value = JSON.parse(\"{}\")\n"],
        ["no-native-timer", "export const value = setTimeout(() => undefined, 1)\n"]
      ]
      for (const [rule, source] of cases) {
        const root = yield* makeFixture({ status: "migrated", source })
        const report = yield* auditRepository(root)
        assert.include(report.violations.map((violation) => violation.rule), rule)
      }
    }))

  it.effect("requires every TypeScript path to have an inventory owner", () =>
    Effect.gen(function*() {
      const root = yield* makeFixture({ addUnassignedFile: true })
      const report = yield* auditRepository(root)
      assert.include(report.violations.map((violation) => violation.rule), "inventory-unassigned")
    }))

  it.effect("reports an invalid inventory pattern as a typed policy error", () =>
    Effect.gen(function*() {
      const root = yield* makeFixture({ inventoryPattern: "[" })
      const error = yield* Effect.flip(auditRepository(root))
      assert.strictEqual(error._tag, "MigrationPolicyReadError")
      assert.strictEqual(error.path, "tooling/effect-migration/inventory.json")
    }))

  it.effect("enforces exact Effect package alignment", () =>
    Effect.gen(function*() {
      const root = yield* makeFixture({ packageEffectVersion: "^4.0.0-beta.102" })
      const report = yield* auditRepository(root)
      assert.include(report.violations.map((violation) => violation.rule), "effect-version-alignment")
    }))

  it.effect("enforces alignment in nested workspace manifests", () =>
    Effect.gen(function*() {
      const root = yield* makeFixture({ workspaceEffectVersion: "4.0.0-beta.101" })
      const report = yield* auditRepository(root)
      assert.include(
        report.violations.map((violation) => `${violation.path}:${violation.rule}`),
        "packages/child/package.json:effect-version-alignment"
      )
    }))

  it.effect("keeps pure slices free of Effect runtime dependencies", () =>
    Effect.gen(function*() {
      const root = yield* makeFixture({
        status: "pure",
        source: "import { Effect } from \"effect\"\nexport const value = Effect.succeed(1)\n"
      })
      const report = yield* auditRepository(root)
      assert.include(report.violations.map((violation) => violation.rule), "pure-code-effect-dependency")
    }))

  it.effect("rejects temporary migration exceptions after final migration", () =>
    Effect.gen(function*() {
      const root = yield* makeFixture({
        source: "export function fail() { throw new Error(\"legacy\") }\n",
        exceptions: [{
          kind: "temporary-migration-adapter",
          path: "src/example.ts",
          rule: "no-throw",
          match: "throw new Error",
          maximumOccurrences: 1,
          reason: "This obsolete fixture attempts to restore migration debt.",
          ownerIssue: 100,
          test: "src/example.ts",
          removalCondition: "Temporary exceptions are forbidden after the final migration.",
          expiresOn: "2099-12-31"
        }]
      })
      const error = yield* Effect.flip(auditRepository(root))
      assert.strictEqual(error._tag, "MigrationPolicyReadError")
      assert.strictEqual(error.path, "tooling/effect-migration/exceptions.json")
    }))

  it.effect("rejects stale exceptions that no longer match a violation", () =>
    Effect.gen(function*() {
      const root = yield* makeFixture({
        status: "migrated",
        exceptions: [{
          kind: "outer-host-adapter",
          path: "src/example.ts",
          rule: "no-runtime-execution",
          match: "BunRuntime.runMain",
          maximumOccurrences: 1,
          reason: "Fixture exception that should become stale.",
          ownerIssue: 100,
          test: "src/example.ts",
          removalCondition: "Remove when issue #100 migrates this fixture adapter.",
          expiresOn: null
        }]
      })
      const report = yield* auditRepository(root)
      assert.include(report.violations.map((violation) => violation.rule), "exception-stale")
    }))

  it.effect("allows one exact reviewed outer runtime invocation", () =>
    Effect.gen(function*() {
      const root = yield* makeFixture({
        status: "migrated",
        source: "import * as BunRuntime from \"@effect/platform-bun/BunRuntime\"\nimport { Effect } from \"effect\"\nBunRuntime.runMain(Effect.void)\n",
        exceptions: [{
          kind: "outer-host-adapter",
          path: "src/example.ts",
          rule: "no-runtime-execution",
          match: "BunRuntime.runMain",
          maximumOccurrences: 1,
          reason: "The fixture models one reviewed process host boundary.",
          ownerIssue: 100,
          test: "src/example.ts",
          removalCondition: "Retain only while the fixture executable needs a Bun host entry.",
          expiresOn: null
        }]
      })
      const report = yield* auditRepository(root)
      assert.isEmpty(report.violations)
    }))

  it.effect("does not let an outer-host adapter exempt domain failures", () =>
    Effect.gen(function*() {
      const root = yield* makeFixture({
        status: "migrated",
        source: "export function fail() { throw new Error(\"not a host boundary\") }\n",
        exceptions: [{
          kind: "outer-host-adapter",
          path: "src/example.ts",
          rule: "no-throw",
          match: "throw new Error",
          maximumOccurrences: 1,
          reason: "This deliberately invalid fixture attempts to widen a host boundary.",
          ownerIssue: 100,
          test: "src/example.ts",
          removalCondition: "This invalid fixture must never suppress a domain failure.",
          expiresOn: null
        }]
      })
      const report = yield* auditRepository(root)
      assert.include(
        report.violations.map((violation) => violation.rule),
        "exception-host-rule-invalid"
      )
      assert.include(
        report.violations.map((violation) => violation.rule),
        "no-throw"
      )
    }))

  it.effect("rejects an exception whose occurrence ceiling is exceeded", () =>
    Effect.gen(function*() {
      const root = yield* makeFixture({
        status: "migrated",
        source: [
          "import * as BunRuntime from \"@effect/platform-bun/BunRuntime\"",
          "import { Effect } from \"effect\"",
          "BunRuntime.runMain(Effect.void)",
          "BunRuntime.runMain(Effect.void)"
        ].join("\n"),
        exceptions: [{
          kind: "outer-host-adapter",
          path: "src/example.ts",
          rule: "no-runtime-execution",
          match: "BunRuntime.runMain",
          maximumOccurrences: 1,
          reason: "The fixture ceiling intentionally permits only one occurrence.",
          ownerIssue: 100,
          test: "src/example.ts",
          removalCondition: "Remove when issue #100 migrates the temporary fixture path.",
          expiresOn: null
        }]
      })
      const report = yield* auditRepository(root)
      assert.include(report.violations.map((violation) => violation.rule), "exception-occurrence-limit")
    }))
})
