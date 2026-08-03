import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import { Crypto, Effect, Encoding, FileSystem, Path, Schema } from "effect";

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
const OpenFgaModelSchema = Schema.Struct({
  schema_version: Schema.Literal("1.1"),
  type_definitions: Schema.Array(Schema.Struct({
    type: Schema.String,
    relations: Schema.optional(Schema.Record(
      Schema.String,
      Schema.Record(Schema.String, Schema.Unknown),
    )),
    metadata: Schema.optional(Schema.Struct({
      relations: Schema.Record(Schema.String, Schema.Struct({
        directly_related_user_types: Schema.Array(Schema.Struct({
          type: Schema.String,
          condition: Schema.optional(Schema.String),
        })),
      })),
    })),
  })),
  conditions: Schema.Record(Schema.String, Schema.Struct({
    name: Schema.String,
    expression: Schema.String,
    parameters: Schema.Record(Schema.String, Schema.Struct({
      type_name: Schema.Literal("TYPE_NAME_TIMESTAMP"),
    })),
  })),
});

const serviceRootUrl = new URL("..", import.meta.url);

layer(BunServices.layer)("OpenFGA release pin", (it) => {
  it.effect("pins reviewed runtime, predecessor, database, and immutable model artifacts", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const serviceRoot = yield* paths.fromFileUrl(serviceRootUrl);
      const releaseSource = yield* fileSystem.readFileString(
        paths.join(serviceRoot, "release.json"),
      );
      const release = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ReleaseSchema),
        { onExcessProperty: "error" },
      )(releaseSource);
      const modelSource = yield* fileSystem.readFileString(
        paths.join(serviceRoot, release.model.artifact),
      );
      const model = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(OpenFgaModelSchema),
        { onExcessProperty: "error" },
      )(modelSource);
      assert.strictEqual(
        Encoding.encodeHex(
          yield* crypto.digest(
            "SHA-256",
            new TextEncoder().encode(modelSource),
          ),
        ),
        release.model.artifactSha256,
      );
      assert.deepStrictEqual(
        model,
        AgentOSOpenFgaAuthorizationModelV1,
      );
      assert.strictEqual(
        release.server.imageIndexDigest,
        release.server.image.slice(release.server.image.indexOf("sha256:")),
      );
    }));
});
