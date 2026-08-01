import * as bun from "@akua-dev/codex-router/bun";
import * as codex from "@akua-dev/codex-router/codex";
import * as core from "@akua-dev/codex-router/core";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

describe("canonical codex-router package", () => {
  it.effect("loads portable policy and Bun adapter from one root dependency", () =>
    Effect.sync(() => {
      assert.isFunction(core.selectAccount);
      assert.isFunction(codex.sanitizeRequestHeaders);
      assert.isFunction(bun.sqliteRoutingStateLayer);
    }));
});
