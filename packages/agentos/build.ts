#!/usr/bin/env bun

import { rm } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = import.meta.dir;
await rm(join(packageRoot, "dist"), { recursive: true, force: true });

const compiler = Bun.spawn(
  ["tsc", "--project", join(packageRoot, "tsconfig.build.json")],
  {
    cwd: packageRoot,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  },
);
process.exitCode = await compiler.exited;
