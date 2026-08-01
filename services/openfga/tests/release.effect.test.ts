import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { AgentOSOpenFgaAuthorizationModelV1 } from "../../../packages/agentos/src/access/openfga.ts";

const Digest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
);
const ReleaseSchema = Schema.Struct({
  server: Schema.Struct({
    version: Schema.Literal("1.18.1"),
    tag: Schema.Literal("v1.18.1"),
    releaseDate: Schema.Literal("2026-06-29"),
    commit: Schema.Literal("69efbd95b3d44afb2e2567d485dcc792c7d79e3f"),
    image: Schema.Literal(
      "docker.io/openfga/openfga@sha256:efde89d24487da1a8bc37d85b61341f1fb7024943a1ded65f4b7d51a75666688",
    ),
    imageIndexDigest: Digest,
  }),
  predecessor: Schema.Struct({
    version: Schema.Literal("1.17.1"),
    image: Schema.String,
    imageIndexDigest: Digest,
  }),
  postgresConformance: Schema.Struct({
    version: Schema.Literal("18.4"),
    image: Schema.String,
    imageIndexDigest: Digest,
  }),
  model: Schema.Struct({
    version: Schema.Literal("agentos-access-v1"),
    artifact: Schema.Literal("model/agentos-access-v1.json"),
    artifactSha256: Schema.String.pipe(
      Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
    ),
  }),
});

const serviceRoot = new URL("..", import.meta.url);

describe("OpenFGA release pin", () => {
  it.effect("pins reviewed runtime, predecessor, database, and immutable model artifacts", () =>
    Effect.gen(function*() {
      const releaseSource = yield* Effect.tryPromise(() =>
        readFile(new URL("release.json", serviceRoot), "utf8")
      );
      const release = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ReleaseSchema),
        { onExcessProperty: "error" },
      )(releaseSource);
      const modelSource = yield* Effect.tryPromise(() =>
        readFile(new URL(release.model.artifact, serviceRoot), "utf8")
      );
      assert.strictEqual(
        createHash("sha256").update(modelSource).digest("hex"),
        release.model.artifactSha256,
      );
      assert.deepStrictEqual(
        JSON.parse(modelSource),
        AgentOSOpenFgaAuthorizationModelV1,
      );
      assert.strictEqual(
        release.server.imageIndexDigest,
        release.server.image.slice(release.server.image.indexOf("sha256:")),
      );
    }));
});
