import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";

import {
  disposableAccessProbeImage,
  runDisposableAccessPlaneProof,
} from "../disposable-kubernetes.ts";
import {
  AccessHardGateEvidenceV1Schema,
  resolveDisposableProofOptions,
  resolveHardGateArtifactPath,
} from "../../resilience/execution.ts";

const platform = Layer.mergeAll(BunServices.layer);

const LiveConfig = Config.all({
  hardGate: Config.boolean("AGENTOS_RESILIENCE_HARD_GATE").pipe(
    Config.withDefault(false),
  ),
  context: Config.option(Config.string("AGENTOS_KUBERNETES_TEST_CONTEXT")),
  approval: Config.option(Config.string("AGENTOS_DISPOSABLE_FLEET_APPROVAL")),
  evidencePath: Config.option(
    Config.string("AGENTOS_RESILIENCE_ACCESS_EVIDENCE_PATH"),
  ),
});

layer(platform)("disposable access-plane Kubernetes boundary", (it) => {
  it.effect("pins the disposable access probe image by digest", () =>
    Effect.sync(() => {
      assert.match(
        disposableAccessProbeImage,
        /^docker\.io\/library\/busybox@sha256:[0-9a-f]{64}$/,
      );
    }));

  it.effect("proves live bound identity, revocation and direct Internet independence under load", () =>
    Effect.gen(function*() {
      const config = yield* LiveConfig;
      const disposable = yield* resolveDisposableProofOptions({
        hardGate: config.hardGate,
        context: Option.getOrNull(config.context),
        approvalReference: Option.getOrNull(config.approval),
      });
      if (Option.isNone(disposable)) {
        yield* Console.log(
          "Disposable access proof unobserved: context or approval is absent",
        );
        return;
      }
      const artifactPath = yield* resolveHardGateArtifactPath({
        hardGate: config.hardGate,
        path: Option.getOrNull(config.evidencePath),
      });
      const evidence = yield* TestClock.withLive(runDisposableAccessPlaneProof({
        context: disposable.value.context,
        approvalReference: disposable.value.approvalReference,
        namespacePrefix: "agentos-access-92",
        revocationSloMillis: 60_000,
        hotReloadSloMillis: 15_000,
        loadAttempts: 32,
      }));
      yield* Effect.logInfo("agentos.access.disposable_proof", {
        context: evidence.context,
        approvalReference: evidence.approvalReference,
        revocationMillis: evidence.revocationMillis,
        hotReloadMillis: evidence.hotReloadMillis,
        loadAttempts: evidence.loadAttempts,
        namespacesDeleted: evidence.namespacesDeleted,
      });
      assert.strictEqual(evidence.wrongAudienceDenied, true);
      assert.strictEqual(evidence.stalePodUidDenied, true);
      assert.strictEqual(evidence.deletedPodDenied, true);
      assert.strictEqual(evidence.staleServiceAccountUidDenied, true);
      assert.strictEqual(evidence.deletedServiceAccountDenied, true);
      assert.strictEqual(evidence.projectedTokensRotated, true);
      assert.strictEqual(evidence.unrelatedSubjectAllowed, true);
      assert.strictEqual(evidence.ordinaryInternetAllowed, true);
      assert.strictEqual(evidence.rollingUpgradeObserved, true);
      assert.strictEqual(evidence.failedRevisionWithheld, true);
      assert.strictEqual(evidence.rollingRollbackObserved, true);
      assert.strictEqual(
        evidence.unrelatedWorkloadAvailableDuringRollback,
        true,
      );
      assert.isAtMost(evidence.revocationMillis, 60_000);
      assert.isAtMost(evidence.hotReloadMillis, 15_000);
      assert.isAtLeast(evidence.loadAttempts, 16);
      assert.strictEqual(evidence.namespacesDeleted, true);
      assert.strictEqual(evidence.productionEndpointContacted, false);
      if (Option.isSome(artifactPath)) {
        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(AccessHardGateEvidenceV1Schema),
        )(evidence);
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(artifactPath.value, encoded);
      }
    }), 180_000);
});
