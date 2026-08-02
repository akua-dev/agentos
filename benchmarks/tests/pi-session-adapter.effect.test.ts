import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

import {
  PiActionTrajectorySchema,
  projectPiSession,
} from "../profiles/agentos/pi-session-adapter.ts";

const JsonFromString = Schema.fromJsonString(Schema.Unknown);
const TrajectoryFromString = Schema.fromJsonString(PiActionTrajectorySchema);

const fixtureEntries: ReadonlyArray<unknown> = [
  { type: "session", version: 3, id: "session-1", timestamp: "2026-07-20T10:00:00.000Z", cwd: "/private/project" },
  { type: "message", id: "entry-1", parentId: null, timestamp: "2026-07-20T10:00:01.000Z", message: { role: "user", content: "full private prompt", timestamp: 1_784_541_601_000 } },
  { type: "message", id: "entry-2", parentId: "entry-1", timestamp: "2026-07-20T10:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "unrelated output" }, { type: "toolCall", id: "call-1", name: "bash", arguments: { headers: { "X-Proprietary": "value", Authorization: "secret" }, command: "curl proprietary.example" } }], timestamp: 1_784_541_602_000 } },
  { type: "message", id: "entry-3", parentId: "entry-2", timestamp: "2026-07-20T10:00:02.125Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "credential and proprietary output" }], isError: true, timestamp: 1_784_541_602_125 } },
  { type: "message", id: "entry-4", parentId: "entry-3", timestamp: "2026-07-20T10:00:02.500Z", message: { role: "bashExecution", command: "printf 'direct private command'", output: "direct private output", exitCode: 0, cancelled: false, truncated: false, timestamp: 1_784_541_602_500 } },
  { type: "message", id: "entry-5", parentId: "entry-4", timestamp: "2026-07-20T10:00:03.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "curl proprietary.example", headers: { Authorization: "secret", "X-Proprietary": "value" } } }], timestamp: 1_784_541_603_000 } },
  { type: "message", id: "entry-6", parentId: "entry-5", timestamp: "2026-07-20T10:00:03.250Z", message: { role: "toolResult", toolCallId: "call-2", toolName: "bash", content: [{ type: "text", text: "ok but still private" }], isError: false, timestamp: 1_784_541_603_250 } },
  { type: "message", id: "entry-7", parentId: "entry-6", timestamp: "2026-07-20T10:00:03.500Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-3", name: "bash", arguments: { command: "curl proprietary.example", headers: { Authorization: "secret", "X-Proprietary": "value" } } }], timestamp: 1_784_541_603_500 } },
  { type: "message", id: "entry-8", parentId: "entry-7", timestamp: "2026-07-20T10:00:03.625Z", message: { role: "toolResult", toolCallId: "call-3", toolName: "bash", content: [{ type: "text", text: "second success remains private" }], isError: false, timestamp: 1_784_541_603_625 } },
  { type: "compaction", id: "entry-9", parentId: "entry-8", timestamp: "2026-07-20T10:00:04.000Z", summary: "private compacted transcript", firstKeptEntryId: "entry-5", tokensBefore: 100 },
  { type: "custom_message", id: "entry-10", parentId: "entry-9", timestamp: "2026-07-20T10:00:05.000Z", customType: "private-extension", content: "private extension content", display: false },
  { type: "model_change", id: "entry-11", parentId: "entry-10", timestamp: "2026-07-20T10:00:06.000Z", provider: "private-provider", modelId: "private-model" },
  { type: "thinking_level_change", id: "entry-12", parentId: "entry-11", timestamp: "2026-07-20T10:00:07.000Z", thinkingLevel: "private-level" },
  { type: "label", id: "entry-13", parentId: "entry-12", timestamp: "2026-07-20T10:00:08.000Z", targetId: "entry-1", label: "private-label" },
  { type: "session_info", id: "entry-14", parentId: "entry-13", timestamp: "2026-07-20T10:00:09.000Z", name: "private-session-name" },
  { type: "message", id: "entry-15", parentId: "entry-14", timestamp: "not-a-timestamp", message: { role: "assistant", content: [{ type: "toolCall", id: "call-4", name: "read", arguments: null }] } },
];

const encodeEntries = Effect.fn("test.piAdapter.encodeEntries")(
  function*(entries: ReadonlyArray<unknown>) {
    const lines = yield* Effect.forEach(
      entries,
      (entry) => Schema.encodeEffect(JsonFromString)(entry),
    );
    return `${lines.join("\n")}\n`;
  },
);

const fixture = encodeEntries(fixtureEntries);

const run = Effect.fn("test.piAdapter.run")(function*(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(command, args, {
      cwd,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  }));
});

describe("Pi session action adapter", () => {
  it.effect("projects only allowlisted action metadata", () =>
    Effect.gen(function*() {
      const trajectory = yield* projectPiSession(
        yield* fixture,
        "agent-123",
        "assignment-456",
      );
      yield* Schema.decodeUnknownEffect(PiActionTrajectorySchema)(trajectory);

      assert.lengthOf(trajectory.events, 5);
      const retryDigest = yield* Effect.fromNullishOr(
        trajectory.events.at(2)?.arguments_digest,
      );
      assert.deepStrictEqual(trajectory.events.at(0), {
        timestamp: "2026-07-20T10:00:02.000Z",
        actor: "agent-123",
        event_type: "tool_call",
        tool_name: "bash",
        arguments_digest: retryDigest,
        result_class: "error",
        duration_ms: 125,
        retry_of: null,
        accepted_work_reference: "assignment-456",
      });
      assert.deepInclude(trajectory.events.at(1), {
        event_type: "bash_execution",
        tool_name: "bash",
        result_class: "success",
        duration_ms: "unobserved",
        retry_of: null,
      });
      assert.strictEqual(trajectory.events.at(2)?.retry_of, 1);
      assert.strictEqual(trajectory.events.at(3)?.retry_of, 1);
      assert.deepInclude(trajectory.events.at(4), {
        timestamp: "unobserved",
        arguments_digest: "unobserved",
        result_class: "unobserved",
        duration_ms: "unobserved",
        retry_of: "unobserved",
      });

      const serialized = yield* Schema.encodeEffect(JsonFromString)(trajectory);
      for (const excluded of [
        "full private prompt",
        "private reasoning",
        "unrelated output",
        "Authorization",
        "X-Proprietary",
        "value",
        "secret",
        "proprietary.example",
        "credential",
        "ok but still private",
        "second success remains private",
        "direct private command",
        "direct private output",
        "private compacted transcript",
        "private extension content",
        "private-extension",
        "private-provider",
        "private-model",
        "private-level",
        "private-label",
        "private-session-name",
        "call-1",
        "/private/project",
      ]) assert.notInclude(serialized, excluded);
      assert.deepStrictEqual(trajectory.redactions, [
        { kind: "assistant_content", count: 1, method: "omitted" },
        { kind: "extension_content", count: 1, method: "omitted" },
        { kind: "full_prompts", count: 1, method: "omitted" },
        { kind: "labels", count: 1, method: "omitted" },
        { kind: "model_changes", count: 1, method: "omitted" },
        { kind: "raw_reasoning", count: 1, method: "omitted" },
        { kind: "session_info", count: 1, method: "omitted" },
        { kind: "session_metadata", count: 1, method: "omitted except supported format version" },
        { kind: "session_summaries", count: 1, method: "omitted" },
        { kind: "thinking_level_changes", count: 1, method: "omitted" },
        { kind: "tool_arguments", count: 4, method: "replaced with canonical JSON SHA-256 digest" },
        { kind: "tool_results", count: 4, method: "classified from native Pi result state, then omitted" },
        { kind: "unavailable_arguments", count: 1, method: "marked unobserved" },
      ]);
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("reads the native session without modifying it", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-pi-adapter-",
      });
      const sessionPath = paths.join(directory, "session.jsonl");
      const content = yield* fixture;
      yield* fileSystem.writeFileString(sessionPath, content, { mode: 0o600 });
      const before = yield* fileSystem.stat(sessionPath);
      const root = yield* paths.fromFileUrl(new URL("../..", import.meta.url));

      const result = yield* run("bun", [
        "benchmarks/profiles/agentos/pi-session-adapter.ts",
        sessionPath,
        "--actor",
        "agent-123",
        "--accepted-work-reference",
        "assignment-456",
      ], root);
      assert.strictEqual(result.exitCode, 0, result.stderr);
      const output = yield* Schema.decodeUnknownEffect(TrajectoryFromString)(
        result.stdout,
      );
      assert.lengthOf(output.events, 5);

      const after = yield* fileSystem.stat(sessionPath);
      assert.strictEqual(yield* fileSystem.readFileString(sessionPath), content);
      assert.strictEqual(after.size, before.size);
      assert.deepStrictEqual(after.mtime, before.mtime);
      assert.strictEqual(after.mode, before.mode);
    })).pipe(Effect.provide(BunServices.layer)));

  it.effect("fails closed for malformed and unsupported native sessions", () =>
    Effect.gen(function*() {
      const malformed = yield* projectPiSession(
        "not-json\n",
        "agent",
        "work",
      ).pipe(Effect.flip);
      assert.include(malformed.message, "valid JSON object");

      const unsupported = yield* projectPiSession(
        yield* encodeEntries([{ type: "session", version: 99 }]),
        "agent",
        "work",
      ).pipe(Effect.flip);
      assert.include(unsupported.message, "unsupported Pi session version");

      const emptyActor = yield* projectPiSession(
        yield* fixture,
        "",
        "work",
      ).pipe(Effect.flip);
      assert.include(emptyActor.message, "actor must not be empty");

      const longActor = yield* projectPiSession(
        yield* fixture,
        "a".repeat(257),
        "work",
      ).pipe(Effect.flip);
      assert.include(longActor.message, "length limit");
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("marks non-native string timestamps unobserved", () =>
    Effect.gen(function*() {
      const content = yield* encodeEntries([
        { type: "session", version: 3 },
        { type: "message", id: "call", parentId: null, timestamp: "2026-07-20", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }], timestamp: "0" } },
        { type: "message", id: "result", parentId: "call", timestamp: "2026-07-21", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, timestamp: "1" } },
      ]);
      const trajectory = yield* projectPiSession(content, "agent", "work");
      assert.deepInclude(trajectory.events.at(0), {
        timestamp: "unobserved",
        duration_ms: "unobserved",
      });
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("does not link retries across event types", () =>
    Effect.gen(function*() {
      const content = yield* encodeEntries([
        { type: "session", version: 3 },
        { type: "message", id: "call", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "false" } }] } },
        { type: "message", id: "result", parentId: "call", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: true } },
        { type: "message", id: "bash", parentId: "result", message: { role: "bashExecution", command: "false", exitCode: 1 } },
      ]);
      const trajectory = yield* projectPiSession(content, "agent", "work");
      assert.deepStrictEqual(
        trajectory.events.map((event) => event.retry_of),
        [null, null],
      );
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("projects only the final leaf ancestry", () =>
    Effect.gen(function*() {
      const content = yield* encodeEntries([
        { type: "session", version: 3 },
        { type: "message", id: "root", parentId: null, message: { role: "user", content: "prompt" } },
        { type: "message", id: "abandoned", parentId: "root", message: { role: "assistant", content: [{ type: "toolCall", id: "old-call", name: "write", arguments: { path: "private" } }] } },
        { type: "message", id: "active", parentId: "root", message: { role: "assistant", content: [{ type: "toolCall", id: "new-call", name: "read", arguments: { path: "private" } }] } },
      ]);
      const trajectory = yield* projectPiSession(content, "agent", "work");
      assert.lengthOf(trajectory.events, 1);
      assert.strictEqual(trajectory.events.at(0)?.tool_name, "read");
      assert.deepInclude(trajectory.redactions, {
        kind: "full_prompts",
        count: 1,
        method: "omitted",
      });
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("fails closed when bounded projection limits are exceeded", () =>
    Effect.gen(function*() {
      const blocks = Array.from({ length: 1_001 }, (_, index) => ({
        type: "toolCall",
        id: `call-${index}`,
        name: "read",
        arguments: {},
      }));
      const content = yield* encodeEntries([
        { type: "session", version: 3 },
        { type: "message", id: "entry", parentId: null, message: { role: "assistant", content: blocks } },
      ]);
      const failure = yield* projectPiSession(
        content,
        "agent",
        "work",
      ).pipe(Effect.flip);
      assert.include(failure.message, "action limit");
    }).pipe(Effect.provide(BunServices.layer)));
});
