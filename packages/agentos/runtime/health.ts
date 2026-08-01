#!/usr/bin/env bun

import { open, stat } from "node:fs/promises";
import { Effect } from "effect";
import {
  evaluateSemanticHealth,
  type HealthCommandResult,
  type HealthFileMetadata,
  type SemanticHealthRuntime,
} from "./readiness";

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

const runtime: SemanticHealthRuntime = {
  run: (args) =>
    Effect.promise(async (): Promise<HealthCommandResult> => {
      try {
        const child = Bun.spawn([...args], {
          env: process.env,
          stderr: "ignore",
          stdout: "pipe",
        });
        const [exitCode, stdout] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
        ]);
        return { exitCode, stdout };
      } catch {
        return { exitCode: 1, stdout: "" };
      }
    }),
  readText: (path, maximumBytes) =>
    Effect.promise(async () => {
      try {
        let handle;
        try {
          handle = await open(path, "r");
        } catch (cause) {
          if (isMissingFile(cause)) return undefined;
          throw cause;
        }
        try {
          const buffer = Buffer.alloc(maximumBytes + 1);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            0,
          );
          if (bytesRead > maximumBytes) return undefined;
          return new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, bytesRead),
          );
        } finally {
          await handle.close();
        }
      } catch {
        return undefined;
      }
    }),
  readFirstLine: (path, maximumBytes) =>
    Effect.promise(async () => {
      try {
        let handle;
        try {
          handle = await open(path, "r");
        } catch (cause) {
          if (isMissingFile(cause)) return undefined;
          throw cause;
        }
        try {
          const bytes: number[] = [];
          const next = Buffer.alloc(1);
          for (let offset = 0; offset <= maximumBytes; offset += 1) {
            const { bytesRead } = await handle.read(next, 0, 1, offset);
            if (bytesRead === 0) {
              return bytes.length === 0
                ? undefined
                : new TextDecoder("utf-8", { fatal: true }).decode(
                    Buffer.from(bytes),
                  );
            }
            const byte = next[0];
            if (byte === undefined) return undefined;
            if (byte === 0x0a) {
              return new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.from(bytes),
              );
            }
            if (offset === maximumBytes) return undefined;
            bytes.push(byte);
          }
          return undefined;
        } finally {
          await handle.close();
        }
      } catch {
        return undefined;
      }
    }),
  metadata: (path) =>
    Effect.promise(async (): Promise<HealthFileMetadata | undefined> => {
      try {
        try {
          const metadata = await stat(path);
          return {
            isFile: metadata.isFile(),
            mode: metadata.mode,
            size: metadata.size,
          };
        } catch (cause) {
          if (isMissingFile(cause)) return undefined;
          throw cause;
        }
      } catch {
        return undefined;
      }
    }),
  processExists: (processId) =>
    Effect.sync(() => {
      if (!Number.isSafeInteger(processId) || processId <= 0) return false;
      try {
        process.kill(processId, 0);
        return true;
      } catch (cause) {
        return (
          cause instanceof Error &&
          "code" in cause &&
          cause.code === "EPERM"
        );
      }
    }),
};

const mode = process.argv[2];
if (mode !== "live" && mode !== "ready") {
  process.stderr.write("Usage: health.ts <live|ready>\n");
  process.exitCode = 2;
} else {
  const diagnostic = await Effect.runPromise(
    evaluateSemanticHealth(process.env, mode, runtime),
  );
  process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
  process.exitCode =
    diagnostic.status === "not_live" || diagnostic.status === "not_ready"
      ? 1
      : 0;
}
