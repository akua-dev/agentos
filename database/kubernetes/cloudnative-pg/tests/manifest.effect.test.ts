import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { fileURLToPath } from "node:url";

import { renderKustomize } from "../../../../tooling/testing/kubernetes.ts";

const Cluster = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.String,
  metadata: Schema.Struct({
    name: Schema.String,
    namespace: Schema.optional(Schema.String),
  }),
  spec: Schema.Struct({
    bootstrap: Schema.Struct({
      initdb: Schema.Struct({
        dataChecksums: Schema.Boolean,
        database: Schema.String,
        owner: Schema.String,
      }),
    }),
    enableSuperuserAccess: Schema.Boolean,
    instances: Schema.Number,
    primaryUpdateStrategy: Schema.String,
    storage: Schema.Struct({ size: Schema.String }),
    walStorage: Schema.Struct({ size: Schema.String }),
    postgresql: Schema.Struct({
      parameters: Schema.Record(Schema.String, Schema.String),
    }),
    monitoring: Schema.Struct({ enablePodMonitor: Schema.Boolean }),
    backup: Schema.Struct({
      target: Schema.String,
      volumeSnapshot: Schema.Struct({
        online: Schema.Boolean,
        snapshotOwnerReference: Schema.String,
        onlineConfiguration: Schema.Struct({
          immediateCheckpoint: Schema.Boolean,
          waitForArchive: Schema.Boolean,
        }),
      }),
    }),
  }),
});
const Clusters = Schema.Array(Cluster);
const databaseDirectory = fileURLToPath(new URL("..", import.meta.url));

describe("AgentOS self-hosted PostgreSQL", () => {
  it.effect("renders one highly available, snapshot-backed CloudNativePG fleet database", () =>
    Effect.gen(function*() {
      const resources = yield* renderKustomize(databaseDirectory).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Clusters)),
      );

      assert.lengthOf(resources, 1);
      const cluster = resources[0];
      assert.isDefined(cluster);
      if (cluster === undefined) return;
      assert.deepStrictEqual({
        apiVersion: cluster.apiVersion,
        kind: cluster.kind,
        name: cluster.metadata.name,
        namespace: cluster.metadata.namespace,
      }, {
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "Cluster",
        name: "agentos-postgres",
        namespace: "agentos",
      });
      assert.deepStrictEqual(cluster.spec, {
        bootstrap: {
          initdb: {
            dataChecksums: true,
            database: "agentos",
            owner: "agentos",
          },
        },
        enableSuperuserAccess: false,
        instances: 3,
        primaryUpdateStrategy: "unsupervised",
        storage: { size: "20Gi" },
        walStorage: { size: "5Gi" },
        postgresql: {
          parameters: {
            max_connections: "200",
            shared_buffers: "256MB",
          },
        },
        monitoring: { enablePodMonitor: false },
        backup: {
          target: "prefer-standby",
          volumeSnapshot: {
            online: true,
            snapshotOwnerReference: "backup",
            onlineConfiguration: {
              immediateCheckpoint: false,
              waitForArchive: false,
            },
          },
        },
      });
    }).pipe(Effect.provide(BunServices.layer)));
});
