import { chmod, mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createAtomicJsonStore, StoreValidationError } from "../src/storage.ts";

const CounterSchema = z.object({ version: z.literal(1), value: z.number().int() }).strict();

describe("atomic private JSON storage", () => {
  test("creates a private directory and file and preserves concurrent updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-router-store-"));
    const path = join(root, "state", "counter.json");
    const store = createAtomicJsonStore({
      path,
      schema: CounterSchema,
      createDefault: () => ({ version: 1 as const, value: 0 }),
    });

    await Promise.all(
      Array.from({ length: 12 }, () =>
        store.update((current) => ({ ...current, value: current.value + 1 })),
      ),
    );

    expect((await store.read()).value).toBe(12);
    expect((await stat(join(root, "state"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.inspect()).toEqual({ exists: true, valid: true, mode: 0o600 });
  });

  test("fails closed when persisted state does not match its schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-router-invalid-"));
    const path = join(root, "state.json");
    await Bun.write(path, JSON.stringify({ version: 1, value: "secret-shape" }));
    await chmod(path, 0o600);
    const store = createAtomicJsonStore({
      path,
      schema: CounterSchema,
      createDefault: () => ({ version: 1 as const, value: 0 }),
    });

    await expect(store.read()).rejects.toBeInstanceOf(StoreValidationError);
    expect(await store.inspect()).toEqual({ exists: true, valid: false, mode: 0o600 });
  });
});
