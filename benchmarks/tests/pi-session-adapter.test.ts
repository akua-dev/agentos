import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020";
import type { AnySchema } from "ajv";
import { projectPiSession } from "../profiles/agentos/pi-session-adapter";

const fixture = [
  { type: "session", version: 3, id: "session-1", timestamp: "2026-07-20T10:00:00.000Z", cwd: "/private/project" },
  { type: "message", id: "entry-1", parentId: null, timestamp: "2026-07-20T10:00:01.000Z", message: { role: "user", content: "full private prompt", timestamp: 1784541601000 } },
  { type: "message", id: "entry-2", parentId: "entry-1", timestamp: "2026-07-20T10:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "unrelated output" }, { type: "toolCall", id: "call-1", name: "bash", arguments: { headers: { "X-Proprietary": "value", Authorization: "secret" }, command: "curl proprietary.example" } }], timestamp: 1784541602000 } },
  { type: "message", id: "entry-3", parentId: "entry-2", timestamp: "2026-07-20T10:00:02.125Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "credential and proprietary output" }], isError: true, timestamp: 1784541602125 } },
  { type: "message", id: "entry-4", parentId: "entry-3", timestamp: "2026-07-20T10:00:02.500Z", message: { role: "bashExecution", command: "printf 'direct private command'", output: "direct private output", exitCode: 0, cancelled: false, truncated: false, timestamp: 1784541602500 } },
  { type: "message", id: "entry-5", parentId: "entry-4", timestamp: "2026-07-20T10:00:03.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "curl proprietary.example", headers: { Authorization: "secret", "X-Proprietary": "value" } } }], timestamp: 1784541603000 } },
  { type: "message", id: "entry-6", parentId: "entry-5", timestamp: "2026-07-20T10:00:03.250Z", message: { role: "toolResult", toolCallId: "call-2", toolName: "bash", content: [{ type: "text", text: "ok but still private" }], isError: false, timestamp: 1784541603250 } },
  { type: "compaction", id: "entry-7", parentId: "entry-6", timestamp: "2026-07-20T10:00:04.000Z", summary: "private compacted transcript", firstKeptEntryId: "entry-5", tokensBefore: 100 },
  { type: "custom_message", id: "entry-8", parentId: "entry-7", timestamp: "2026-07-20T10:00:05.000Z", customType: "private-extension", content: "private extension content", display: false },
  { type: "message", id: "entry-9", parentId: "entry-8", timestamp: "not-a-timestamp", message: { role: "assistant", content: [{ type: "toolCall", id: "call-3", name: "read", arguments: null }] } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";

describe("Pi session action adapter", () => {
  test("projects only allowlisted action metadata and validates its contract", async () => {
    const trajectory = projectPiSession(fixture, "agent-123", "assignment-456");
    const schema = JSON.parse(await readFile(join(import.meta.dir, "../profiles/agentos/pi-action-trajectory.schema.json"), "utf8")) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

    expect(validate(trajectory)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(trajectory.events).toHaveLength(4);
    expect(trajectory.events[0]).toEqual({
      timestamp: "2026-07-20T10:00:02.000Z",
      actor: "agent-123",
      event_type: "tool_call",
      tool_name: "bash",
      arguments_digest: trajectory.events[2]!.arguments_digest,
      result_class: "error",
      duration_ms: 125,
      retry_of: null,
      accepted_work_reference: "assignment-456",
    });
    expect(trajectory.events[1]).toMatchObject({
      event_type: "bash_execution",
      tool_name: "bash",
      result_class: "success",
      duration_ms: "unobserved",
      retry_of: null,
    });
    expect(trajectory.events[2]!.retry_of).toBe(1);
    expect(trajectory.events[3]).toMatchObject({
      timestamp: "unobserved",
      arguments_digest: "unobserved",
      result_class: "unobserved",
      duration_ms: "unobserved",
      retry_of: "unobserved",
    });

    const serialized = JSON.stringify(trajectory);
    for (const excluded of ["full private prompt", "private reasoning", "unrelated output", "Authorization", "X-Proprietary", "value", "secret", "proprietary.example", "credential", "ok but still private", "direct private command", "direct private output", "private compacted transcript", "private extension content", "private-extension", "call-1", "/private/project"]) {
      expect(serialized).not.toContain(excluded);
    }
    expect(trajectory.redactions).toEqual([
      { kind: "assistant_content", count: 1, method: "omitted" },
      { kind: "extension_content", count: 1, method: "omitted" },
      { kind: "full_prompts", count: 1, method: "omitted" },
      { kind: "raw_reasoning", count: 1, method: "omitted" },
      { kind: "session_summaries", count: 1, method: "omitted" },
      { kind: "tool_arguments", count: 3, method: "replaced with canonical JSON SHA-256 digest" },
      { kind: "tool_results", count: 3, method: "classified from native Pi result state, then omitted" },
      { kind: "unavailable_arguments", count: 1, method: "marked unobserved" },
    ]);
  });

  test("reads the native session without modifying it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-pi-adapter-"));
    const sessionPath = join(directory, "session.jsonl");
    await writeFile(sessionPath, fixture, { mode: 0o600 });
    const before = await stat(sessionPath);

    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "../profiles/agentos/pi-session-adapter.ts"),
      sessionPath,
      "--actor",
      "agent-123",
      "--accepted-work-reference",
      "assignment-456",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    const output = await new Response(child.stdout).text();
    expect(JSON.parse(output).events).toHaveLength(4);

    const after = await stat(sessionPath);
    expect(await readFile(sessionPath, "utf8")).toBe(fixture);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode).toBe(before.mode);
  });

  test("fails closed for malformed and unsupported native sessions", () => {
    expect(() => projectPiSession("not-json\n", "agent", "work")).toThrow("not valid JSON");
    expect(() => projectPiSession(`${JSON.stringify({ type: "session", version: 99 })}\n`, "agent", "work")).toThrow("unsupported Pi session version");
    expect(() => projectPiSession(fixture, "", "work")).toThrow("actor must not be empty");
    expect(() => projectPiSession(fixture, "a".repeat(257), "work")).toThrow("length limit");
  });

  test("projects only the final leaf ancestry", () => {
    const entries = [
      { type: "session", version: 3 },
      { type: "message", id: "root", parentId: null, message: { role: "user", content: "prompt" } },
      { type: "message", id: "abandoned", parentId: "root", message: { role: "assistant", content: [{ type: "toolCall", id: "old-call", name: "write", arguments: { path: "private" } }] } },
      { type: "message", id: "active", parentId: "root", message: { role: "assistant", content: [{ type: "toolCall", id: "new-call", name: "read", arguments: { path: "private" } }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n");

    const trajectory = projectPiSession(entries, "agent", "work");
    expect(trajectory.events).toHaveLength(1);
    expect(trajectory.events[0]!.tool_name).toBe("read");
    expect(trajectory.redactions).toContainEqual({ kind: "full_prompts", count: 1, method: "omitted" });
  });

  test("fails closed when the bounded projection limits are exceeded", () => {
    const blocks = Array.from({ length: 1001 }, (_, index) => ({
      type: "toolCall",
      id: `call-${index}`,
      name: "read",
      arguments: {},
    }));
    const entries = [
      { type: "session", version: 3 },
      { type: "message", id: "entry", parentId: null, message: { role: "assistant", content: blocks } },
    ].map((entry) => JSON.stringify(entry)).join("\n");

    expect(() => projectPiSession(entries, "agent", "work")).toThrow("action limit");
  });
});
