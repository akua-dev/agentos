import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, layer } from "@effect/vitest";
import { Data, Effect, FileSystem, Layer, Path } from "effect";

import {
  registerPiWorkloadIdentity,
  resolvePiWorkloadIdentity,
} from "../pi-workload-identity.ts";
import { makePiTestHarness } from "../../../tests/pi-test-harness.ts";

const gatewayUrl =
  "http://agentgateway-openai.agentos.svc.cluster.local:8788";
const assignmentId = "20000000-0000-4000-8000-000000000001";
const environment = {
  AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
  AGENTOS_ASSIGNMENT_ID: assignmentId,
  AI_GATEWAY_URL: gatewayUrl,
};
const gatewayModel = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
  baseUrl: gatewayUrl,
};
const platform = Layer.merge(BunFileSystem.layer, BunPath.layer);

class PiIdentityTestBoundaryError extends Data.TaggedError(
  "PiIdentityTestBoundaryError",
)<{}> {}

function emit(
  fake: Effect.Success<ReturnType<typeof makePiTestHarness>>,
  headers: Record<string, string | null>,
) {
  return fake.emit("before_provider_headers", {
    type: "before_provider_headers",
    headers,
  }).pipe(Effect.mapError(() => new PiIdentityTestBoundaryError()));
}

describe("Effect Pi projected workload identity", () => {
  layer(platform)((it) => {
    it.effect("reads every kubelet token rotation and strips forged identity", () =>
      Effect.scoped(Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "agentos-pi-identity-",
        });
        const tokenFile = path.join(directory, "token");
        const fake = yield* makePiTestHarness({
          context: { model: gatewayModel },
        });
        registerPiWorkloadIdentity(fake.pi, { environment, tokenFile });

        yield* fileSystem.writeFileString(
          tokenFile,
          "header.first.signature",
          { mode: 0o440 },
        );
        const first: Record<string, string | null> = {
          Authorization: "Bearer static-placeholder",
          "x-ai-gateway-token": "legacy-shared-token",
          "X-AgentOS-Authz-Decision-Ref": "forged-decision",
        };
        yield* emit(fake, first);
        assert.include(first, {
          authorization: "Bearer header.first.signature",
          "x-ai-gateway-token": null,
          "x-agentos-assignment-id": assignmentId,
        });
        assert.isNull(first.Authorization);
        assert.isNull(first["X-AgentOS-Authz-Decision-Ref"]);

        yield* fileSystem.chmod(tokenFile, 0o640);
        yield* fileSystem.writeFileString(
          tokenFile,
          "header.rotated.signature",
          { mode: 0o440 },
        );
        const rotated: Record<string, string | null> = {
          authorization: "Bearer static-placeholder",
        };
        yield* emit(fake, rotated);
        assert.strictEqual(
          rotated.authorization,
          "Bearer header.rotated.signature",
        );
      })));

    it.effect("fails closed on unavailable identity and leaves direct providers untouched", () =>
      Effect.gen(function*() {
        const missing = yield* resolvePiWorkloadIdentity(gatewayModel, {
          environment,
          tokenFile: "/missing/projected/token",
        });
        assert.deepStrictEqual(missing, { active: true });

        const direct = yield* resolvePiWorkloadIdentity({
          ...gatewayModel,
          baseUrl: "https://chatgpt.com/backend-api",
        }, { environment });
        assert.deepStrictEqual(direct, { active: false });
      }));
  });
});
