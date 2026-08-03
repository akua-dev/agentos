import { createHash } from "node:crypto"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { parseSync, visitorKeys } from "oxc-parser"

const StrictRule = Schema.Literals([
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
])

const Policy = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  effectVersion: Schema.String,
  effectPackages: Schema.Array(Schema.String),
  ignoredDirectories: Schema.Array(Schema.String),
  ignoredPaths: Schema.Array(Schema.String),
  strictRules: Schema.Array(StrictRule)
})

const InventorySlice = Schema.Struct({
  id: Schema.String,
  issue: Schema.Number,
  pattern: Schema.String,
  runtime: Schema.String,
  package: Schema.String,
  io: Schema.Array(Schema.String),
  migrationDependencies: Schema.Array(Schema.Number),
  status: Schema.Literals(["migrated", "pure", "runtime-boundary"])
})

const Inventory = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  slices: Schema.Array(InventorySlice)
})

const BoundaryException = Schema.Struct({
  kind: Schema.Literal("outer-host-adapter"),
  path: Schema.String,
  rule: StrictRule,
  match: Schema.String,
  maximumOccurrences: Schema.Number,
  reason: Schema.String,
  ownerIssue: Schema.Number,
  test: Schema.String,
  removalCondition: Schema.String,
  expiresOn: Schema.Null
})

const Exceptions = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  exceptions: Schema.Array(BoundaryException)
})

const PackageManifest = Schema.Struct({
  name: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

type Policy = typeof Policy.Type
type InventorySlice = typeof InventorySlice.Type
type BoundaryException = typeof BoundaryException.Type
type StrictRule = typeof StrictRule.Type

export interface PolicyViolation {
  readonly rule: string
  readonly path: string
  readonly line?: number
  readonly fingerprint?: string
  readonly message: string
}

export interface InventoryAssignment {
  readonly path: string
  readonly slice: string
  readonly issue: number
  readonly status: InventorySlice["status"]
  readonly runtime: string
  readonly package: string
  readonly io: ReadonlyArray<string>
  readonly migrationDependencies: ReadonlyArray<number>
}

export interface AuditReport {
  readonly files: number
  readonly assignments: ReadonlyArray<InventoryAssignment>
  readonly violations: ReadonlyArray<PolicyViolation>
}

export class MigrationPolicyReadError extends Schema.TaggedErrorClass<MigrationPolicyReadError>()(
  "MigrationPolicyReadError",
  {
    path: Schema.String,
    message: Schema.String
  }
) {}

type AstRule = StrictRule | "pure-code-effect-dependency"

interface AstViolation extends PolicyViolation {
  readonly rule: AstRule
  readonly sourceText: string
}

const manifestDirectory = "tooling/effect-migration"

const asReadError = (path: string) => (cause: unknown) =>
  MigrationPolicyReadError.make({ path, message: String(cause) })

const readManifest = <S extends Schema.Top>(root: string, relativePath: string, schema: S) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const absolutePath = path.join(root, relativePath)
    const contents = yield* fs.readFileString(absolutePath).pipe(
      Effect.mapError(asReadError(relativePath))
    )
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(contents).pipe(
      Effect.mapError(asReadError(relativePath))
    )
  })

const toRepositoryPath = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//, "")

const compilePattern = (manifestPath: string, pattern: string) =>
  Effect.try({
    try: () => new RegExp(pattern, "u"),
    catch: (cause) => MigrationPolicyReadError.make({
      path: manifestPath,
      message: `Invalid regular expression ${pattern}: ${String(cause)}`
    })
  })

const isIgnored = (
  file: string,
  ignoredDirectories: ReadonlyArray<string>,
  ignoredPaths: ReadonlyArray<RegExp>
) => {
  const segments = toRepositoryPath(file).split("/")
  return ignoredDirectories.some((directory) => segments.includes(directory)) ||
    ignoredPaths.some((pattern) => pattern.test(file))
}

const isTypeScriptPath = (file: string) => file.endsWith(".ts") || file.endsWith(".tsx")

interface CompiledSlice {
  readonly slice: InventorySlice
  readonly pattern: RegExp
}

const assignSlice = (file: string, slices: ReadonlyArray<CompiledSlice>) =>
  slices.find(({ pattern }) => pattern.test(file))?.slice

interface AstNode {
  readonly type: string
  readonly start: number
  readonly end: number
  readonly [key: string]: unknown
}

const lineOf = (source: string, node: AstNode) => source.slice(0, node.start).split("\n").length

const asNode = (value: unknown): AstNode | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string" ||
    !("start" in value) ||
    typeof value.start !== "number" ||
    !("end" in value) ||
    typeof value.end !== "number"
  ) return undefined
  return value
}

const isNonReferencePropertyName = (
  parent: AstNode | undefined,
  key: string | undefined
) => parent !== undefined &&
  key === "key" &&
  [
    "Property",
    "MethodDefinition",
    "PropertyDefinition",
    "TSMethodSignature",
    "TSPropertySignature"
  ].includes(parent.type) &&
  parent.computed !== true

const expressionName = (expression: AstNode | undefined): string => {
  if (expression === undefined) return ""
  if (expression.type === "Identifier" && typeof expression.name === "string") return expression.name
  if (expression.type === "MemberExpression") {
    const object = expressionName(asNode(expression.object))
    const property = expressionName(asNode(expression.property))
    return object.length === 0 ? property : `${object}.${property}`
  }
  return ""
}

const inspectAst = (
  file: string,
  source: string,
  enabledRules: ReadonlySet<StrictRule>,
  pure: boolean
): ReadonlyArray<AstViolation> => {
  const parsed = parseSync(file, source, {
    lang: file.endsWith(".tsx") ? "tsx" : file.endsWith(".d.ts") ? "dts" : "ts",
    sourceType: "module"
  })
  const violations: Array<AstViolation> = []
  const add = (rule: AstRule, node: AstNode, message: string) => {
    if (rule !== "pure-code-effect-dependency" && !enabledRules.has(rule)) return
    violations.push({
      rule,
      path: file,
      line: lineOf(source, node),
      fingerprint: createHash("sha256")
        .update(source.slice(node.start, node.end), "utf8")
        .digest("hex"),
      message,
      sourceText: source.slice(node.start, node.end)
    })
  }

  const visit = (
    node: AstNode,
    parent?: AstNode,
    parentKey?: string
  ): void => {
    if (
      node.type === "Identifier" &&
      node.name === "fetch" &&
      !isNonReferencePropertyName(parent, parentKey)
    ) {
      add("no-raw-http", node, "Use the Effect HTTP client service.")
    }
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
      if (node.async === true) add("no-async-function", node, "Use Effect for asynchronous work in migrated code.")
    }

    if (node.type === "NewExpression" && expressionName(asNode(node.callee)) === "Promise") {
      add("no-new-promise", node, "Use Effect.async or an Effect platform service instead of constructing Promise.")
    }
    if (node.type === "ThrowStatement") {
      add("no-throw", node, "Represent expected failures as tagged errors in the Effect error channel.")
    }
    if (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") {
      add("no-type-assertion", node, "Narrow, decode, or simplify the type instead of asserting it.")
    }
    if (node.type === "MemberExpression") {
      const name = expressionName(node)
      if (name === "process.env" || name.startsWith("process.env.") || name === "Bun.env" || name.startsWith("Bun.env.")) {
        add("no-ambient-env", node, "Read owned configuration through Effect Config.")
      }
    }
    if (node.type === "ImportDeclaration") {
      const sourceNode = asNode(node.source)
      const moduleName = typeof sourceNode?.value === "string" ? sourceNode.value : ""
      if (pure && (moduleName === "effect" || moduleName.startsWith("effect/") || moduleName.startsWith("@effect/"))) {
        add("pure-code-effect-dependency", node, "A pure inventory slice must not depend on the Effect runtime.")
      }
      if (moduleName === "node:fs" || moduleName === "node:fs/promises") {
        add("no-raw-filesystem", node, "Depend on Effect FileSystem at the adapter boundary.")
      }
      if (moduleName === "node:child_process") {
        add("no-raw-process", node, "Depend on Effect ChildProcessSpawner at the adapter boundary.")
      }
    }
    if (node.type === "CallExpression") {
      const name = expressionName(asNode(node.callee))
      if (["Effect.runPromise", "Effect.runPromiseExit", "Effect.runSync", "Effect.runSyncExit", "BunRuntime.runMain"].includes(name)) {
        add("no-runtime-execution", node, "Run Effect only in a reviewed application or framework entry adapter.")
      }
      if (["Bun.file", "Bun.write"].includes(name)) {
        add("no-raw-filesystem", node, "Use the Effect FileSystem service.")
      }
      if (["Bun.spawn", "Bun.spawnSync"].includes(name)) {
        add("no-raw-process", node, "Use the Effect ChildProcessSpawner service.")
      }
      if (name === "JSON.parse") {
        add("no-untyped-json-parse", node, "Decode JSON and its owned contract with Effect Schema.")
      }
      if (["setTimeout", "setInterval"].includes(name)) {
        add("no-native-timer", node, "Use Effect Clock, sleep, Schedule, or TestClock.")
      }
    }

    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key]
      if (Array.isArray(child)) {
        for (const item of child) {
          const childNode = asNode(item)
          if (childNode !== undefined) visit(childNode, node, key)
        }
      } else {
        const childNode = asNode(child)
        if (childNode !== undefined) visit(childNode, node, key)
      }
    }
  }

  const program = asNode(parsed.program)
  if (program !== undefined) visit(program)
  return violations
}

const effectDependencyEntries = (manifest: typeof PackageManifest.Type) => [
  manifest.dependencies,
  manifest.devDependencies,
  manifest.peerDependencies,
  manifest.optionalDependencies
].flatMap((dependencies) => dependencies === undefined ? [] : Object.entries(dependencies))

const auditVersions = Effect.fn("effectMigration.auditVersions")(function*(
  root: string,
  files: ReadonlyArray<string>,
  policy: Policy
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const violations: Array<PolicyViolation> = []
  const seenPackages = new Set<string>()
  const packageFiles = ["package.json", ...files.filter((file) => file.endsWith("/package.json"))]

  for (const packageFile of packageFiles) {
    const contents = yield* fs.readFileString(path.join(root, packageFile)).pipe(
      Effect.mapError(asReadError(packageFile))
    )
    const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))(contents).pipe(
      Effect.mapError(asReadError(packageFile))
    )
    for (const [name, version] of effectDependencyEntries(manifest)) {
      if (name !== "effect" && !name.startsWith("@effect/")) continue
      seenPackages.add(name)
      if (!policy.effectPackages.includes(name)) {
        violations.push({
          rule: "effect-package-policy",
          path: packageFile,
          message: `${name} is not declared in policy.json.`
        })
      } else if (version !== policy.effectVersion) {
        violations.push({
          rule: "effect-version-alignment",
          path: packageFile,
          message: `${name} must use exact version ${policy.effectVersion}; found ${version}.`
        })
      }
    }
  }

  for (const name of policy.effectPackages) {
    if (!seenPackages.has(name)) {
      violations.push({
        rule: "effect-package-missing",
        path: "package.json",
        message: `${name} is required by the repository Effect package policy.`
      })
    }
  }
  return violations
})

const applyExceptions = (
  rawViolations: ReadonlyArray<AstViolation>,
  exceptions: ReadonlyArray<BoundaryException>,
  sources: ReadonlyMap<string, string>,
  assignments: ReadonlyMap<string, InventorySlice>
) => {
  const violations: Array<PolicyViolation> = []
  const usable = new Set<BoundaryException>()

  for (const exception of exceptions) {
    const source = sources.get(exception.path)
    const assignment = assignments.get(exception.path)
    const matchingViolations = rawViolations.filter((violation) =>
      violation.path === exception.path &&
      violation.rule === exception.rule &&
      violation.sourceText.includes(exception.match)
    )
    const occurrenceCount = matchingViolations.length
    if (
      exception.reason.trim().length < 20 ||
      exception.removalCondition.trim().length < 30 ||
      exception.ownerIssue < 1 ||
      exception.maximumOccurrences < 1
    ) {
      violations.push({
        rule: "exception-invalid",
        path: exception.path,
        message: "An exception needs a substantive reason/removal condition, owner issue, and positive maximumOccurrences."
      })
    } else if (!sources.has(exception.test)) {
      violations.push({
        rule: "exception-test-missing",
        path: exception.path,
        message: `The reviewed boundary test ${exception.test} is not an assigned TypeScript path.`
      })
    } else if (
      exception.kind === "outer-host-adapter" &&
      exception.rule !== "no-runtime-execution"
    ) {
      violations.push({
        rule: "exception-host-rule-invalid",
        path: exception.path,
        message: "An outer host adapter may exempt only one runtime invocation, never domain I/O or failure logic."
      })
    } else if (assignment?.status !== "migrated" && assignment?.status !== "runtime-boundary") {
      violations.push({
        rule: "exception-outside-enforced-slice",
        path: exception.path,
        message: "Exceptions may only describe an enforced migrated or runtime-boundary path."
      })
    } else if (source === undefined || occurrenceCount === 0) {
      violations.push({
        rule: "exception-stale",
        path: exception.path,
        message: `The ${exception.rule} exception no longer matches an active violation.`
      })
    } else if (occurrenceCount > exception.maximumOccurrences) {
      violations.push({
        rule: "exception-occurrence-limit",
        path: exception.path,
        message: `The exception matches ${occurrenceCount} occurrences, above its limit of ${exception.maximumOccurrences}.`
      })
    } else {
      usable.add(exception)
    }
  }

  for (const violation of rawViolations) {
    const suppressed = [...usable].some((exception) =>
      exception.path === violation.path &&
      exception.rule === violation.rule &&
      violation.sourceText.includes(exception.match)
    )
    if (!suppressed) {
      const { sourceText: _, ...publicViolation } = violation
      violations.push(publicViolation)
    }
  }
  return violations
}

export const auditRepository = Effect.fn("effectMigration.auditRepository")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const [policy, inventory, exceptionManifest] = yield* Effect.all([
    readManifest(root, `${manifestDirectory}/policy.json`, Policy),
    readManifest(root, `${manifestDirectory}/inventory.json`, Inventory),
    readManifest(root, `${manifestDirectory}/exceptions.json`, Exceptions)
  ])
  const ignoredPathPatterns = yield* Effect.forEach(policy.ignoredPaths, (pattern) =>
    compilePattern(`${manifestDirectory}/policy.json`, pattern))
  const compiledSlices = yield* Effect.forEach(inventory.slices, (slice) =>
    compilePattern(`${manifestDirectory}/inventory.json`, slice.pattern).pipe(
      Effect.map((pattern) => ({ slice, pattern }))
    ))
  const entries = (yield* fs.readDirectory(root, { recursive: true }).pipe(
    Effect.mapError(asReadError(root))
  )).map(toRepositoryPath).filter((file) =>
    !isIgnored(file, policy.ignoredDirectories, ignoredPathPatterns)
  )
  const sourceFiles = entries.filter(isTypeScriptPath).sort()
  const violations: Array<PolicyViolation> = []
  const assignments: Array<InventoryAssignment> = []
  const assignedSlices = new Map<string, InventorySlice>()
  const sources = new Map<string, string>()
  const rawAstViolations: Array<AstViolation> = []
  const enabledRules = new Set(policy.strictRules)

  for (const file of sourceFiles) {
    const slice = assignSlice(file, compiledSlices)
    if (slice === undefined) {
      violations.push({
        rule: "inventory-unassigned",
        path: file,
        message: "Every AgentOS-owned TypeScript path must match an inventory slice."
      })
      continue
    }
    assignedSlices.set(file, slice)
    assignments.push({
      path: file,
      slice: slice.id,
      issue: slice.issue,
      status: slice.status,
      runtime: slice.runtime,
      package: slice.package,
      io: slice.io,
      migrationDependencies: slice.migrationDependencies
    })
    const source = yield* fs.readFileString(path.join(root, file)).pipe(
      Effect.mapError(asReadError(file))
    )
    sources.set(file, source)
    rawAstViolations.push(...inspectAst(file, source, enabledRules, slice.status === "pure"))
  }

  for (const slice of inventory.slices) {
    if (!assignments.some((assignment) => assignment.slice === slice.id)) {
      violations.push({
        rule: "inventory-empty-slice",
        path: `${manifestDirectory}/inventory.json`,
        message: `Inventory slice ${slice.id} matches no TypeScript paths.`
      })
    }
  }

  const exceptionFiltered = applyExceptions(
    rawAstViolations,
    exceptionManifest.exceptions,
    sources,
    assignedSlices
  )
  violations.push(...exceptionFiltered)
  violations.push(...yield* auditVersions(root, entries, policy))

  return {
    files: sourceFiles.length,
    assignments,
    violations: violations.sort((left, right) =>
      left.path.localeCompare(right.path) || left.rule.localeCompare(right.rule) || (left.line ?? 0) - (right.line ?? 0)
    )
  } satisfies AuditReport
})

export const checkRepository = Effect.fn("effectMigration.checkRepository")(function*(root: string) {
  const report = yield* auditRepository(root)
  if (report.violations.length === 0) return report
  for (const violation of report.violations) {
    const location = violation.line === undefined ? violation.path : `${violation.path}:${violation.line}`
    yield* Console.error(`${location} [${violation.rule}] ${violation.message}`)
  }
  return yield* Effect.fail(
    MigrationPolicyReadError.make({
      path: root,
      message: `Effect migration policy found ${report.violations.length} violation(s).`
    })
  )
})

const main = Effect.gen(function*() {
  const path = yield* Path.Path
  const report = yield* checkRepository(path.resolve("."))
  yield* Console.log(`Effect migration policy: ${report.files} TypeScript paths assigned; no violations.`)
}).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)))

if (import.meta.main) {
  BunRuntime.runMain(main)
}
