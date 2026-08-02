import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import { Crypto, Effect, FileSystem, Path, Schema } from "effect";

const databaseRootUrl = new URL("../", import.meta.url);

const publishedMigrations = [
  {
    hash: "9e2ce0914ca67d45d0c3c21d5236ea7c0a44f85fdebca25d4dff6a514fea4e7a",
    tag: "0000_initial_fleet_schema",
    when: 1784120250263,
  },
  {
    hash: "14d64ee4b6a2d5f24ea8c56345fa6ea568aa259d30c3d2fc5b057e463714d795",
    tag: "0001_agent_authorization",
    when: 1784136281608,
  },
  {
    hash: "9e8e16d92e514910f9078970e2ea0384b509a9c67c419472d4b09a3983ea0a58",
    tag: "0002_runtime_mutation_authorization",
    when: 1784138679947,
  },
  {
    hash: "ec4e8082592bcb96636a1ae0665c856a7d580dbe754eb905adebda4f1cf4855b",
    tag: "0003_initialize_fleet_owner",
    when: 1784139850586,
  },
  {
    hash: "432050d3f2a6c93561d1ec1b49be3c502e2233fb05f0fcde4fa3e37e1eee7d70",
    tag: "0004_provision_agents",
    when: 1784147553125,
  },
  {
    hash: "f6685e55fb16ec4e92c8a0cbc949fb83bf50e7a52ed0be4f649db3cbf711e8bb",
    tag: "0005_durable_coordination_contracts",
    when: 1784276874451,
  },
  {
    hash: "326da342394b5553bfcdbb2823df6ca361da5a2d7903d6796801956b81752c62",
    tag: "0006_fleet_notifications",
    when: 1784317041855,
  },
  {
    hash: "ddea7b49b705e1bcf79b2a96cfb5809ffdebbc30fe57e6410177816d678378a4",
    tag: "0007_inbox_hierarchy_edge_routing",
    when: 1784395533147,
  },
  {
    hash: "fd1a6d19ec76fd2b045f63cc7396718f79370beb0bf7bfb5fb52578a0666de9e",
    tag: "0008_inbox_speech_act_vocabulary",
    when: 1784395682062,
  },
  {
    hash: "e78665abe4216f4cf6f5d9b5754aa91df6fd97b68e9348dfe12cffe64950883c",
    tag: "0009_inbox_receipt",
    when: 1784407912979,
  },
  {
    hash: "8fca086c3e2c886071d708bbfd1d58b30cc8750bf5752dd3ced8e788906d9aac",
    tag: "0010_preserve_runtime_privileges",
    when: 1784409309452,
  },
  {
    hash: "f88a5b04b83fa358f3ae5cc855c259a263458506662bc1e5a987ca8133319ceb",
    tag: "0011_agent_composition",
    when: 1784810821916,
  },
  {
    hash: "57f2de93c76605d315c236266359983995576c9915cbdb735c087ae1cad7dd66",
    tag: "0012_atomic_task_acceptance",
    when: 1785144306433,
  },
  {
    hash: "64331bf771cd948bac2c92c09a536e34e50debf387683a4e528925e15e382c24",
    tag: "0013_current_mate_bearings",
    when: 1785144898319,
  },
  {
    hash: "295f2c59a19b8c6345a09557951160b6726011cc549913df0578552f51b532cd",
    tag: "0014_targeted_mate_notifications",
    when: 1785145385518,
  },
  {
    hash: "29fd164a862bf810b80b7197fac494ee505741ca77deab07e2c6c816921bf08f",
    tag: "0015_mate_memory",
    when: 1785198333179,
  },
];

const JournalSchema = Schema.Struct({
  entries: Schema.Array(Schema.Struct({
    idx: Schema.Number,
    tag: Schema.String,
    when: Schema.Number,
  })),
});

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

layer(BunServices.layer)("published database migrations", (it) => {
  it.effect("keeps history append-only and byte-identical", () =>
    Effect.gen(function*() {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const databaseRoot = yield* paths.fromFileUrl(databaseRootUrl);
      const journal = yield* fileSystem.readFileString(
        paths.join(databaseRoot, "migrations", "meta", "_journal.json"),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(
          Schema.fromJsonString(JournalSchema),
        )),
      );

      assert.deepStrictEqual(
        journal.entries.slice(0, publishedMigrations.length).map((entry) => ({
          tag: entry.tag,
          when: entry.when,
        })),
        publishedMigrations.map(({ tag, when }) => ({ tag, when })),
      );

      const hashes = yield* Effect.forEach(publishedMigrations, ({ tag }) =>
        fileSystem.readFile(
          paths.join(databaseRoot, "migrations", `${tag}.sql`),
        ).pipe(
          Effect.flatMap((contents) => crypto.digest("SHA-256", contents)),
          Effect.map(hex),
        ));
      assert.deepStrictEqual(
        Array.from(hashes),
        publishedMigrations.map(({ hash }) => hash),
      );
    }));
});
