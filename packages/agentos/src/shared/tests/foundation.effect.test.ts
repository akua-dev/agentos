import { assert, describe, it } from "@effect/vitest";
import {
  Clock,
  ConfigProvider,
  Effect,
  FileSystem,
  Random,
  Ref,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";

import {
  AgentOSInstructionSourceV1Schema,
  AgentOSNameClaimsV1Schema,
  AgentOSResourceInputV1Schema,
  AgentOSStartupContributionV1Schema,
  decodeAgentOSContract,
} from "../contracts.ts";
import {
  AgentOSContractError,
  toAgentOSFailureEnvelope,
} from "../errors.ts";
import {
  AgentOSDiagnostics,
  AgentOSIdentifier,
  type AgentOSDiagnostic,
} from "../services.ts";
import {
  preflightAgentOSRegistrationsEffect,
  registerAgentOSRuntimeEffect,
  type AgentOSRegistrationV1,
} from "../../preflight.ts";
import { makePiTestHarness } from "../../../tests/pi-test-harness.ts";
import { buildAgentOSInstructionsEffect } from "../../instructions.ts";
import * as BunPath from "@effect/platform-bun/BunPath";
import { resolveAgentOSResourcesEffect } from "../../resources.ts";
import { buildAgentOSStartupPromptEffect } from "../../startup.ts";
import { selectedDefaultAgentOSRoleEffect } from "../../roles/default.ts";
import { writeCoordinationReadinessEffect } from "../../readiness-state.ts";

describe("AgentOS shared Effect foundation", () => {
  it.effect("round-trips every released version-1 shared wire shape", () =>
    Effect.gen(function*() {
      const claims = {
        version: 1,
        tools: ["run_background_command"],
        skills: ["agentos-supervision"],
      } satisfies typeof AgentOSNameClaimsV1Schema.Encoded;
      const decodedClaims = yield* Schema.decodeUnknownEffect(
        AgentOSNameClaimsV1Schema,
      )(claims);
      assert.deepStrictEqual(
        yield* Schema.encodeEffect(AgentOSNameClaimsV1Schema)(decodedClaims),
        claims,
      );

      const instructions = {
        version: 1,
        id: "@akua-dev/agentos:first_mate:identity",
        content: "Remain accountable for the Fleet.",
      } satisfies typeof AgentOSInstructionSourceV1Schema.Encoded;
      const decodedInstructions = yield* Schema.decodeUnknownEffect(
        AgentOSInstructionSourceV1Schema,
      )(instructions);
      assert.deepStrictEqual(
        yield* Schema.encodeEffect(AgentOSInstructionSourceV1Schema)(
          decodedInstructions,
        ),
        instructions,
      );

      const resources = {
        version: 1,
        baseDirectory: "/opt/agentos/packages/agentos",
        skillPaths: ["skills", "resources/roles/firstmate/skills"],
      } satisfies typeof AgentOSResourceInputV1Schema.Encoded;
      const decodedResources = yield* Schema.decodeUnknownEffect(
        AgentOSResourceInputV1Schema,
      )(resources);
      assert.deepStrictEqual(
        yield* Schema.encodeEffect(AgentOSResourceInputV1Schema)(
          decodedResources,
        ),
        resources,
      );

      const startup = {
        version: 1,
        id: "@akua-dev/agentos:first_mate:supervision",
        skill: "agentos-supervision",
        instruction: "Reconcile durable work before accepting more.",
      } satisfies typeof AgentOSStartupContributionV1Schema.Encoded;
      const decodedStartup = yield* Schema.decodeUnknownEffect(
        AgentOSStartupContributionV1Schema,
      )(startup);
      assert.deepStrictEqual(
        yield* Schema.encodeEffect(AgentOSStartupContributionV1Schema)(
          decodedStartup,
        ),
        startup,
      );
    }));

  it.effect("turns decode failures into typed safe boundary context", () =>
    Effect.gen(function*() {
      const error = yield* decodeAgentOSContract(
        AgentOSInstructionSourceV1Schema,
        "instruction_source",
      )({
        version: 2,
        id: "@akua-dev/agentos:test",
        content: "Bearer credential-must-not-leak",
      }).pipe(Effect.flip);

      assert.instanceOf(error, AgentOSContractError);
      assert.strictEqual(error.code, "invalid_contract");
      assert.strictEqual(error.boundary, "instruction_source");
      assert.strictEqual(error.path, "$.version");
      const serialized = JSON.stringify(toAgentOSFailureEnvelope(error));
      assert.notInclude(serialized, "credential-must-not-leak");
      assert.deepStrictEqual(toAgentOSFailureEnvelope(error), {
        version: 1,
        error: {
          code: "invalid_contract",
          message: "Invalid AgentOS instruction_source at $.version",
          context: {
            boundary: "instruction_source",
            path: "$.version",
          },
        },
      });
    }));

  it.effect("derives repeatable identifiers from the Effect Random service", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const identifiers = yield* AgentOSIdentifier;
        return yield* Effect.all([identifiers.next, identifiers.next]);
      }).pipe(Effect.provide(AgentOSIdentifier.layer));

      const first = yield* program.pipe(Random.withSeed("agentos-test-seed"));
      const second = yield* program.pipe(Random.withSeed("agentos-test-seed"));
      assert.deepStrictEqual(first, second);
      assert.match(first[0], /^evt_[0-9a-f]{32}$/);
      assert.notStrictEqual(first[0], first[1]);
    }));

  it.effect("captures deterministic diagnostics without credentials or protected payloads", () =>
    Effect.gen(function*() {
      const captured = yield* Ref.make<ReadonlyArray<AgentOSDiagnostic>>([]);
      yield* TestClock.setTime(1_785_556_800_000);
      const program = Effect.gen(function*() {
        const diagnostics = yield* AgentOSDiagnostics;
        yield* diagnostics.emit({
          component: "shared_contracts",
          operation: "decode",
          outcome: "failure",
          attributes: {
            "agentos.agent.id": "agent_firstmate",
            "agentos.reason": "invalid_contract",
            authorization: "Bearer credential-must-not-leak",
            password: "credential-must-not-leak",
            payload: "protected-payload-must-not-leak",
            prompt: "protected-prompt-must-not-leak",
            token: "credential-must-not-leak",
          },
        });
      }).pipe(
        Effect.provide(
          AgentOSDiagnostics.test(captured, ["evt_diagnostic_1"]),
        ),
      );

      yield* program;
      const events = yield* Ref.get(captured);
      assert.deepStrictEqual(events, [
        {
          id: "evt_diagnostic_1",
          timestampMillis: 1_785_556_800_000,
          component: "shared_contracts",
          operation: "decode",
          outcome: "failure",
          attributes: {
            "agentos.agent.id": "agent_firstmate",
            "agentos.reason": "invalid_contract",
          },
        },
      ]);
      const serialized = JSON.stringify(events);
      assert.notInclude(serialized, "credential-must-not-leak");
      assert.notInclude(serialized, "protected-payload-must-not-leak");
      assert.notInclude(serialized, "protected-prompt-must-not-leak");
      assert.strictEqual(yield* Clock.currentTimeMillis, 1_785_556_800_000);
    }));

  it.effect("reports registration collisions as typed validation failures", () =>
    Effect.gen(function*() {
      const registration = (id: string): AgentOSRegistrationV1 => ({
        version: 1,
        id,
        names: { version: 1, tools: ["shared-tool"] },
        register: () => Effect.void,
      });
      const error = yield* preflightAgentOSRegistrationsEffect([
        registration("@example/one"),
        registration("@example/two"),
      ]).pipe(Effect.flip);

      assert.strictEqual(error._tag, "AgentOSValidationError");
      assert.strictEqual(error.code, "duplicate_name");
      assert.strictEqual(error.boundary, "registration");
      assert.strictEqual(error.field, "tools");
      assert.strictEqual(
        error.message,
        'AgentOS tool "shared-tool" is claimed by both "@example/one" and "@example/two"',
      );
    }));

  it.effect("registers Effect programs in order", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const order: string[] = [];
      const registrations: readonly AgentOSRegistrationV1[] = [
        {
          version: 1,
          id: "@example/first",
          names: { version: 1 },
          register() {
            return Effect.sync(() => order.push("first"));
          },
        },
        {
          version: 1,
          id: "@example/second",
          names: { version: 1 },
          register() {
            return Effect.sync(() => order.push("second"));
          },
        },
        {
          version: 1,
          id: "@example/third",
          names: { version: 1 },
          register() {
            return Effect.sync(() => order.push("third"));
          },
        },
      ];

      yield* registerAgentOSRuntimeEffect(fake.pi, registrations);
      assert.deepStrictEqual(order, ["first", "second", "third"]);
    }));

  it.effect("assembles instructions with typed duplicate diagnostics", () =>
    Effect.gen(function*() {
      const source = {
        version: 1,
        id: "@example/instructions",
        content: "Keep the durable contract.",
      } satisfies typeof AgentOSInstructionSourceV1Schema.Type;
      assert.strictEqual(
        yield* buildAgentOSInstructionsEffect([source]),
        [
          '<agentos-instructions id="@example/instructions">',
          "Keep the durable contract.",
          "</agentos-instructions>",
        ].join("\n"),
      );

      const error = yield* buildAgentOSInstructionsEffect([
        source,
        source,
      ]).pipe(Effect.flip);
      assert.strictEqual(error._tag, "AgentOSValidationError");
      assert.strictEqual(error.code, "duplicate_name");
      assert.strictEqual(error.boundary, "instruction_source");
      assert.strictEqual(error.field, "id");
    }));

  it.effect("rejects escaping resource paths with a typed safe path failure", () =>
    Effect.gen(function*() {
      const error = yield* resolveAgentOSResourcesEffect({
        version: 1,
        baseDirectory: "/distribution",
        skillPaths: ["../credential-must-not-leak"],
      }).pipe(Effect.provide(BunPath.layer), Effect.flip);

      assert.strictEqual(error._tag, "AgentOSValidationError");
      assert.strictEqual(error.code, "invalid_shape");
      assert.strictEqual(error.boundary, "resources");
      assert.strictEqual(error.field, "skillPaths");
      assert.notInclude(
        JSON.stringify(toAgentOSFailureEnvelope(error)),
        "credential-must-not-leak",
      );
    }));

  it.effect("reports startup contribution bounds through the typed channel", () =>
    Effect.gen(function*() {
      const oversized = {
        version: 1,
        id: "@example/oversized",
        skill: "example-startup",
        instruction: "🙂".repeat(513),
      } satisfies typeof AgentOSStartupContributionV1Schema.Type;
      const error = yield* buildAgentOSStartupPromptEffect([oversized]).pipe(
        Effect.flip,
      );

      assert.strictEqual(error._tag, "AgentOSValidationError");
      assert.strictEqual(error.code, "limit_exceeded");
      assert.strictEqual(error.boundary, "startup_contribution");
      assert.strictEqual(error.field, "instruction");
      assert.strictEqual(
        error.message,
        'startup contribution "@example/oversized" instruction exceeds 2048 UTF-8 bytes',
      );
    }));

  it.effect("loads the selected role through Effect Config", () =>
    Effect.gen(function*() {
      const provider = ConfigProvider.fromUnknown({
        AGENTOS_AGENT_ROLE: "second_mate",
      });
      assert.strictEqual(
        yield* selectedDefaultAgentOSRoleEffect.pipe(
          Effect.provide(ConfigProvider.layer(provider)),
        ),
        "second_mate",
      );

      const invalid = ConfigProvider.fromUnknown({
        AGENTOS_AGENT_ROLE: "captain",
      });
      const error = yield* selectedDefaultAgentOSRoleEffect.pipe(
        Effect.provide(ConfigProvider.layer(invalid)),
        Effect.flip,
      );
      assert.strictEqual(error._tag, "AgentOSValidationError");
      assert.strictEqual(error.code, "invalid_shape");
      assert.strictEqual(error.field, "AGENTOS_AGENT_ROLE");
    }));

  it.effect("writes readiness through injected filesystem and identifier services", () =>
    Effect.gen(function*() {
      const operations = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (operation: string) =>
        Ref.update(operations, (current) => [...current, operation]);
      const fileSystem = FileSystem.layerNoop({
        makeDirectory: (path, options) =>
          record(`mkdir:${path}:${options?.mode}:${options?.recursive}`),
        writeFileString: (path, content, options) =>
          record(
            `write:${path}:${content.trim()}:${options?.flag}:${options?.mode}`,
          ),
        chmod: (path, mode) => record(`chmod:${path}:${mode}`),
        rename: (from, to) => record(`rename:${from}:${to}`),
        remove: (path, options) =>
          record(`remove:${path}:${options?.force}`),
      });

      const state = yield* writeCoordinationReadinessEffect({
        agentName: "firstmate",
        herdrSession: "agentos-firstmate",
        listenerProcessId: 9001,
        listenerTaskId: "bg-listener",
        ownerProcessId: 4242,
        phase: "listening",
        stateDirectory: "/state",
      }).pipe(
        Effect.provide(fileSystem),
        Effect.provide(BunPath.layer),
        Effect.provide(AgentOSIdentifier.test(["evt_readiness_1"])),
      );

      assert.strictEqual(state.version, 1);
      assert.deepStrictEqual(yield* Ref.get(operations), [
        "mkdir:/state/readiness:448:true",
        'write:/state/readiness/coordination.json.evt_readiness_1.agentos-next:{"agentName":"firstmate","herdrSession":"agentos-firstmate","listenerProcessId":9001,"listenerTaskId":"bg-listener","ownerProcessId":4242,"phase":"listening","version":1}:wx:384',
        "chmod:/state/readiness/coordination.json.evt_readiness_1.agentos-next:384",
        "rename:/state/readiness/coordination.json.evt_readiness_1.agentos-next:/state/readiness/coordination.json",
        "remove:/state/readiness/coordination.json.evt_readiness_1.agentos-next:true",
      ]);
    }));
});
