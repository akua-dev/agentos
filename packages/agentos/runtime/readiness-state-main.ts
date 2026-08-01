#!/usr/bin/env bun

import { open } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import {
  confirmCrewmateReadiness,
  CrewmateConfirmationError,
  type CrewmateConfirmationRuntime,
} from "./crewmate-readiness";

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

const runtime: CrewmateConfirmationRuntime = {
  run: (args) =>
    Effect.promise(async () => {
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
      let handle;
      try {
        try {
          handle = await open(path, "r");
        } catch (cause) {
          if (isMissingFile(cause)) return undefined;
          throw cause;
        }
        const buffer = Buffer.alloc(maximumBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > maximumBytes) return undefined;
        return new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, bytesRead),
        );
      } catch {
        return undefined;
      } finally {
        await handle?.close();
      }
    }),
};

if (process.argv[2] !== "confirm-crewmate") {
  process.stderr.write("Usage: readiness-state-main.ts confirm-crewmate\n");
  process.exitCode = 2;
} else {
  const home = process.env.HOME?.trim();
  if (!home) {
    process.stderr.write(
      '{"reason":"runtime_configuration_invalid","status":"failed","version":1}\n',
    );
    process.exitCode = 1;
  } else {
    try {
      const state = await Effect.runPromise(
        confirmCrewmateReadiness(
          process.env,
          runtime,
          join(home, ".local", "state", "agentos"),
        ),
      );
      process.stdout.write(
        `${JSON.stringify({ status: "confirmed", state, version: 1 })}\n`,
      );
    } catch (cause) {
      const reason =
        cause instanceof CrewmateConfirmationError
          ? cause.reason
          : "confirmation_internal_error";
      process.stderr.write(
        `${JSON.stringify({ reason, status: "failed", version: 1 })}\n`,
      );
      process.exitCode = 1;
    }
  }
}
