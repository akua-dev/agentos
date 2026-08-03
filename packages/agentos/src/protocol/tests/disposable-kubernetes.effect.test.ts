import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
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

import { runDisposableProtocolIdentityProof } from "../disposable-kubernetes.ts";
import {
  ProtocolHardGateEvidenceV1Schema,
  resolveDisposableProofOptions,
  resolveHardGateArtifactPath,
} from "../../resilience/execution.ts";

const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)),
  ),
);

const LiveConfig = Config.all({
  hardGate: Config.boolean("AGENTOS_RESILIENCE_HARD_GATE").pipe(
    Config.withDefault(false),
  ),
  context: Config.option(Config.string("AGENTOS_KUBERNETES_TEST_CONTEXT")),
  approval: Config.option(
    Config.string("AGENTOS_DISPOSABLE_FLEET_APPROVAL"),
  ),
  evidencePath: Config.option(
    Config.string("AGENTOS_RESILIENCE_PROTOCOL_EVIDENCE_PATH"),
  ),
});

describe("disposable ACP/A2A Kubernetes identity boundary", () => {
  it.effect("proves projected identity, direct-edge RBAC, denial, revocation, and cleanup", () =>
    Effect.gen(function*() {
      const config = yield* LiveConfig;
      const disposable = yield* resolveDisposableProofOptions({
        hardGate: config.hardGate,
        context: Option.getOrNull(config.context),
        approvalReference: Option.getOrNull(config.approval),
      });
      if (Option.isNone(disposable)) {
        yield* Console.log(
          "Disposable protocol proof unobserved: context or approval is absent",
        );
        return;
      }
      const artifactPath = yield* resolveHardGateArtifactPath({
        hardGate: config.hardGate,
        path: Option.getOrNull(config.evidencePath),
      });
      const evidence = yield* TestClock.withLive(
        runDisposableProtocolIdentityProof({
          context: disposable.value.context,
          approvalReference: disposable.value.approvalReference,
          namespacePrefix: "agentos-protocol-130",
          revocationSloMillis: 60_000,
        }),
      );
      yield* Effect.logInfo("agentos.protocol.disposable_identity_proof", {
        context: evidence.context,
        approvalReference: evidence.approvalReference,
        revocationMillis: evidence.revocationMillis,
        namespacesDeleted: evidence.namespacesDeleted,
      });
      assert.strictEqual(evidence.version, 1);
      assert.strictEqual(evidence.productionEndpointContacted, false);
      assert.strictEqual(evidence.parentChildAllowed, true);
      assert.strictEqual(evidence.siblingDenied, true);
      assert.strictEqual(evidence.crossDomainDenied, true);
      assert.strictEqual(evidence.tokenReviewAuthenticated, true);
      assert.strictEqual(evidence.expiredIdentityDenied, true);
      assert.isAtMost(evidence.revocationMillis, 60_000);
      assert.strictEqual(evidence.piPodReplaced, true);
      assert.strictEqual(evidence.piNativeSessionResumed, true);
      assert.strictEqual(evidence.codexPodReplaced, true);
      assert.strictEqual(evidence.codexNativeSessionResumed, true);
      assert.strictEqual(evidence.namespacesDeleted, true);
      if (Option.isSome(artifactPath)) {
        const fileSystem = yield* FileSystem.FileSystem;
        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(ProtocolHardGateEvidenceV1Schema),
        )({
          version: 1,
          context: evidence.context,
          approvalReference: evidence.approvalReference,
          revocationMillis: evidence.revocationMillis,
          parentChildAllowed: true,
          siblingDenied: true,
          crossDomainDenied: true,
          expiredIdentityDenied: true,
          piPodReplaced: true,
          piNativeSessionResumed: true,
          codexPodReplaced: true,
          codexNativeSessionResumed: true,
          namespacesDeleted: true,
          productionEndpointContacted: false,
        });
        yield* fileSystem.writeFileString(artifactPath.value, encoded);
      }
    }).pipe(Effect.provide(platform)), 120_000);
});
