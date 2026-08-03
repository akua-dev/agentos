import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  AGENTOS_RESILIENCE_SCENARIOS,
  RESILIENCE_REGRESSION_SOURCES,
  ResilienceRegressionSourceError,
  verifyResilienceRegressionSources,
} from "../conformance.ts";

const platform = Layer.merge(BunFileSystem.layer, BunPath.layer);
const repositoryRootUrl = new URL("../../../../../", import.meta.url);

function verificationFailure(input: unknown) {
  return verifyResilienceRegressionSources(input).pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() =>
        assert.instanceOf(failure, ResilienceRegressionSourceError)
      )
    ),
  );
}

layer(platform)("resilience regression source verification", (it) => {
  it.effect("binds every scenario to distinct existing Effect regressions", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const repositoryRoot = paths.resolve(
        yield* paths.fromFileUrl(repositoryRootUrl),
      );
      const verdict = yield* verifyResilienceRegressionSources({
        repositoryRoot,
        references: RESILIENCE_REGRESSION_SOURCES,
      });
      assert.deepStrictEqual(verdict, {
        version: 1,
        scenarioCount: AGENTOS_RESILIENCE_SCENARIOS.length,
        referenceCount: AGENTOS_RESILIENCE_SCENARIOS.length * 2,
        allEffectNative: true,
      });
    }));

  it.effect("rejects a missing scenario and a reused original regression", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const repositoryRoot = paths.resolve(
        yield* paths.fromFileUrl(repositoryRootUrl),
      );
      const missing = yield* verificationFailure({
        repositoryRoot,
        references: RESILIENCE_REGRESSION_SOURCES.slice(2),
      });
      assert.strictEqual(missing.code, "scenario_reference_missing");

      const first = RESILIENCE_REGRESSION_SOURCES[0];
      const second = RESILIENCE_REGRESSION_SOURCES[1];
      assert.isDefined(first);
      assert.isDefined(second);
      if (first === undefined || second === undefined) return;
      const reused = yield* verificationFailure({
        repositoryRoot,
        references: RESILIENCE_REGRESSION_SOURCES.map((reference) =>
          reference === second
            ? {
              ...reference,
              path: first.path,
              title: first.title,
            }
            : reference
        ),
      });
      assert.strictEqual(reused.code, "original_held_out_reused");
    }));

  it.effect("rejects missing files, absent titles, and non-Effect tests", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const repositoryRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-resilience-sources-",
      });
      const proofDirectory = paths.join(repositoryRoot, "packages", "proof");
      yield* fileSystem.makeDirectory(proofDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        paths.join(proofDirectory, "proof.effect.test.ts"),
        'it("ordinary test is not enough", () => undefined);\n',
      );
      const template = RESILIENCE_REGRESSION_SOURCES[0];
      assert.isDefined(template);
      if (template === undefined) return;

      const missingFile = yield* verificationFailure({
        repositoryRoot,
        references: [{
          ...template,
          path: "packages/proof/missing.effect.test.ts",
        }],
      });
      assert.strictEqual(missingFile.code, "file_unavailable");

      const missingTitle = yield* verificationFailure({
        repositoryRoot,
        references: [{
          ...template,
          path: "packages/proof/proof.effect.test.ts",
          title: "title that does not exist",
        }],
      });
      assert.strictEqual(missingTitle.code, "title_missing");

      const nonEffect = yield* verificationFailure({
        repositoryRoot,
        references: [{
          ...template,
          path: "packages/proof/proof.effect.test.ts",
          title: "ordinary test is not enough",
        }],
      });
      assert.strictEqual(nonEffect.code, "non_effect_regression");
    })));
});
