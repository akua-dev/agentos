#!/usr/bin/env bun

import { run } from "@agentos/cli";

if (import.meta.main) {
  process.exitCode = await run(Bun.argv.slice(2));
}
