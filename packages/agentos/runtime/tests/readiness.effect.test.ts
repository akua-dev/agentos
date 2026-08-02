import { describe, expect, it } from "@effect/vitest";
import { Effect, Hash } from "effect";
import {
  evaluateSemanticHealth,
  type HealthEnvironment,
  type SemanticHealthRuntime,
} from "../readiness";

type RuntimeOptions = {
  commands?: Readonly<Record<string, { exitCode: number; stdout: string }>>;
  files?: Readonly<Record<string, string>>;
  liveProcessIds?: ReadonlyArray<number>;
  parseToml?: (source: string) => unknown | undefined;
  unavailableFiles?: ReadonlyArray<string>;
  unavailableTextFiles?: ReadonlyArray<string>;
};

const home = "/home/agent";
const cwd = "/home/agent/projects/agentos/packages/agentos/resources/roles/firstmate";
const session = "agentos-firstmate";
const pane = "w1:p1";
const processId = 4242;
const piSession = `${home}/.pi/agent/sessions/firstmate.jsonl`;
const providerState = `${home}/.local/state/agentos/pi-provider-readiness.json`;
const settingsPath = `${home}/.pi/agent/settings.json`;
const authPath = `${home}/.pi/agent/auth.json`;
const pgpassPath = `${home}/.pgpass`;
const coordinationState = `${home}/.local/state/agentos/readiness/coordination.json`;
const egressTokenPath = "/var/run/secrets/agentos-egress/token";

function sha256(value: string): string {
  const fragment = (Hash.string(value) >>> 0).toString(16).padStart(8, "0");
  return fragment.repeat(8);
}

function commandKey(args: ReadonlyArray<string>): string {
  return JSON.stringify(args);
}

function runtime(options: RuntimeOptions = {}): SemanticHealthRuntime {
  const files = options.files ?? {};
  const unavailable = new Set(options.unavailableFiles ?? []);
  const unavailableText = new Set(options.unavailableTextFiles ?? []);
  return {
    basename: (path) => path.split("/").at(-1) ?? path,
    join: (...paths) => paths.join("/").replaceAll(/\/{2,}/g, "/"),
    parseToml: (source) => Effect.succeed(options.parseToml?.(source)),
    run: (args) =>
      Effect.succeed(
        options.commands?.[commandKey(args)] ?? {
          exitCode: 1,
          stdout: "",
        },
      ),
    sha256: (source) => Effect.succeed(sha256(source)),
    readText: (path, maximumBytes) =>
      Effect.succeed(
        unavailable.has(path) ||
          unavailableText.has(path) ||
          files[path] === undefined
          ? undefined
          : files[path]!.slice(0, maximumBytes),
      ),
    readFirstLine: (path, maximumBytes) =>
      Effect.succeed(
        unavailable.has(path) || files[path] === undefined
          ? undefined
          : files[path]!.split("\n", 1)[0]!.slice(0, maximumBytes),
      ),
    metadata: (path) =>
      Effect.succeed(
        unavailable.has(path) || files[path] === undefined
          ? undefined
          : { isFile: true, mode: 0o600, size: Buffer.byteLength(files[path]!) },
      ),
    processExists: (candidateProcessId) =>
      Effect.succeed(
        (options.liveProcessIds ?? [9001]).includes(candidateProcessId),
      ),
  };
}

function mateEnvironment(
  overrides: Partial<HealthEnvironment> = {},
): HealthEnvironment {
  return {
    HOME: home,
    AGENTOS_AGENT_CWD: cwd,
    AGENTOS_AGENT_NAME: "firstmate",
    AGENTOS_AGENT_ROLE: "first_mate",
    AGENTOS_DATABASE_IDENTITY: "runtime_firstmate",
    AGENTOS_DATABASE_URL:
      "postgresql://runtime_firstmate@postgres.agentos.svc:5432/agentos?sslmode=require",
    AGENTOS_MODEL: "openai-codex/gpt-5.6-sol",
    AGENTOS_PI_PROVIDER_MODE: "direct",
    AGENTOS_PROVIDER_CREDENTIAL_KIND: "pi_auth",
    HERDR_SESSION: session,
    PI_CODING_AGENT_DIR: `${home}/.pi/agent`,
    PGPASSFILE: pgpassPath,
    ...overrides,
  };
}

function healthyMateRuntime(
  overrides: RuntimeOptions = {},
): SemanticHealthRuntime {
  const settings = `${JSON.stringify({
    defaultModel: "gpt-5.6-sol",
    defaultProvider: "openai-codex",
  })}\n`;
  const files = {
    [piSession]: `${JSON.stringify({ cwd, id: "session-1", type: "session", version: 3 })}\n`,
    [settingsPath]: settings,
    [authPath]: "not-read-by-readiness",
    [pgpassPath]: "not-read-by-readiness",
    [providerState]: `${JSON.stringify({
      files: {
        markerSha256: null,
        modelsSha256: null,
        settingsSha256: sha256(settings),
      },
      mode: "direct",
      selectedModel: "openai-codex/gpt-5.6-sol",
      selectedThinking: null,
      version: 1,
    })}\n`,
    [coordinationState]: `${JSON.stringify({
      agentName: "firstmate",
      herdrSession: session,
      listenerProcessId: 9001,
      listenerTaskId: "bg-listener",
      ownerProcessId: processId,
      phase: "caught_up",
      version: 1,
    })}\n`,
    ...overrides.files,
  };
  const commands = {
    [commandKey(["herdr", "status", "--json", "--session", session])]: {
      exitCode: 0,
      stdout: '{"result":{"running":true}}\n',
    },
    [commandKey(["herdr", "agent", "list", "--session", session])]: {
      exitCode: 0,
      stdout: `${JSON.stringify({
        result: {
          agents: [
            {
              agent_session: { kind: "path", value: piSession },
              agent_status: "idle",
              cwd,
              foreground_cwd: cwd,
              name: "firstmate",
              pane_id: pane,
            },
          ],
        },
      })}\n`,
    },
    [commandKey([
      "herdr",
      "agent",
      "explain",
      "firstmate",
      "--json",
      "--session",
      session,
    ])]: {
      exitCode: 0,
      stdout: '{"agent":"pi","state":"idle"}\n',
    },
    [commandKey([
      "herdr",
      "pane",
      "process-info",
      "--pane",
      pane,
      "--session",
      session,
    ])]: {
      exitCode: 0,
      stdout: `${JSON.stringify({
        result: {
          process_info: {
            foreground_process_group_id: processId,
            foreground_processes: [{ argv0: "pi", cwd, pid: processId }],
            pane_id: pane,
          },
        },
      })}\n`,
    },
    ...overrides.commands,
  };
  return runtime({ ...overrides, commands, files });
}

function evaluate(
  environment: HealthEnvironment,
  mode: "live" | "ready",
  probeRuntime: SemanticHealthRuntime,
) {
  return evaluateSemanticHealth(environment, mode, probeRuntime);
}

function reasonCodes(
  result: { readonly reasons: ReadonlyArray<{ readonly code: string }> },
): ReadonlyArray<string> {
  return result.reasons.map(({ code }) => code);
}

describe("semantic Agent readiness", () => {
  it.effect("fails readiness with a stable reason for an unknown runtime role", () => Effect.gen(function*() {
    const result = yield* evaluate(
      mateEnvironment({ AGENTOS_AGENT_ROLE: "unknown-role" }),
      "ready",
      healthyMateRuntime(),
    );
    expect(result).toMatchObject({ role: "unknown", status: "not_ready" });
    expect(reasonCodes(result)).toEqual(["runtime_configuration_invalid"]);
  }));

  it.effect("keeps liveness narrow and emits stable diagnostic JSON data", () => Effect.gen(function*() {
    const result = yield* evaluate(
      mateEnvironment(),
      "live",
      healthyMateRuntime(),
    );
    expect(result).toEqual({
      checks: [{ component: "herdr", status: "pass" }],
      mode: "live",
      reasons: [],
      role: "first_mate",
      status: "live",
      version: 1,
    });

    const invalidStatus = yield* evaluate(
      mateEnvironment(),
      "live",
      healthyMateRuntime({
        commands: {
          [commandKey([
            "herdr",
            "status",
            "--json",
            "--session",
            session,
          ])]: { exitCode: 0, stdout: "not-json\n" },
        },
      }),
    );
    expect(invalidStatus.status).toBe("not_live");
    expect(reasonCodes(invalidStatus)).toEqual(["herdr_unavailable"]);
  }));

  it.effect("reports a fully prepared Mate ready without reading auth contents", () => Effect.gen(function*() {
    const result = yield* evaluate(
      mateEnvironment(),
      "ready",
      healthyMateRuntime({ unavailableTextFiles: [piSession] }),
    );
    expect(result.status).toBe("ready");
    expect(result.reasons).toEqual([]);
    expect(result.checks.map(({ component }) => component)).toEqual([
      "herdr",
      "agent",
      "harness",
      "session",
      "provider",
      "credential",
      "database",
      "coordination",
    ]);
  }));

  it.effect("distinguishes missing Agent, wrong harness, and invalid native session", () => Effect.gen(function*() {
    const missingAgent = yield* evaluate(
      mateEnvironment(),
      "ready",
      healthyMateRuntime({
        commands: {
          [commandKey(["herdr", "agent", "list", "--session", session])]: {
            exitCode: 0,
            stdout: '{"result":{"agents":[]}}\n',
          },
        },
      }),
    );
    expect(reasonCodes(missingAgent)).toEqual(["agent_missing"]);

    const wrongHarness = yield* evaluate(
      mateEnvironment(),
      "ready",
      healthyMateRuntime({
        commands: {
          [commandKey([
            "herdr",
            "agent",
            "explain",
            "firstmate",
            "--json",
            "--session",
            session,
          ])]: { exitCode: 0, stdout: '{"agent":"codex","state":"idle"}\n' },
        },
      }),
    );
    expect(reasonCodes(wrongHarness)).toContain("harness_mismatch");

    const wrongSession = yield* evaluate(
      mateEnvironment(),
      "ready",
      healthyMateRuntime({
        files: {
          [piSession]: `${JSON.stringify({ cwd: "/wrong", id: "session-1", type: "session" })}\n`,
        },
      }),
    );
    expect(reasonCodes(wrongSession)).toContain("session_cwd_mismatch");
  }));

  it.effect("distinguishes provider drift from unavailable provider credentials", () => Effect.gen(function*() {
    const drifted = yield* evaluate(
      mateEnvironment(),
      "ready",
      healthyMateRuntime({
        files: { [settingsPath]: '{"defaultProvider":"other"}\n' },
      }),
    );
    expect(reasonCodes(drifted)).toContain("provider_configuration_invalid");

    const unavailable = yield* evaluate(
      mateEnvironment(),
      "ready",
      healthyMateRuntime({ unavailableFiles: [authPath] }),
    );
    expect(reasonCodes(unavailable)).toContain(
      "provider_credential_unavailable",
    );
  }));

  it.effect("requires the projected workload token in Gateway mode", () => Effect.gen(function*() {
    const environment = mateEnvironment({
      AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
      AGENTOS_PROVIDER_CREDENTIAL_KIND: "ai_gateway",
      AI_GATEWAY_URL:
        "http://agentgateway-openai.agentos.svc.cluster.local:8788",
    });
    const ready = yield* evaluate(
      environment,
      "ready",
      healthyMateRuntime({
        files: { [egressTokenPath]: "header.payload.signature" },
      }),
    );
    expect(
      ready.checks.find(({ component }) => component === "credential"),
    ).toEqual({ component: "credential", status: "pass" });
    expect(reasonCodes(ready)).not.toContain("provider_credential_unavailable");

    const missing = yield* evaluate(
      environment,
      "ready",
      healthyMateRuntime(),
    );
    expect(reasonCodes(missing)).toContain("provider_credential_unavailable");
  }));

  it.effect("distinguishes database identity, database credential, listener, and catch-up recovery", () => Effect.gen(function*() {
    const databaseUrl =
      "postgresql://runtime_firstmate@postgres.agentos.svc:5432/agentos?sslmode=require";
    const pgpass = `${home}/.pgpass`;
    const environment = mateEnvironment({
      AGENTOS_DATABASE_IDENTITY: "runtime_firstmate",
      AGENTOS_DATABASE_URL: databaseUrl,
      PGPASSFILE: pgpass,
    });
    const baseFiles = { [pgpass]: "not-read-by-readiness" };

    const missingConnection = yield* evaluate(
      mateEnvironment({
        AGENTOS_DATABASE_IDENTITY: undefined,
        AGENTOS_DATABASE_URL: undefined,
      }),
      "ready",
      healthyMateRuntime(),
    );
    expect(reasonCodes(missingConnection)).toContain(
      "database_identity_unconfigured",
    );

    const wrongIdentity = yield* evaluate(
      { ...environment, AGENTOS_DATABASE_IDENTITY: "someone_else" },
      "ready",
      healthyMateRuntime({ files: baseFiles }),
    );
    expect(reasonCodes(wrongIdentity)).toContain("database_identity_mismatch");

    const missingCredential = yield* evaluate(
      environment,
      "ready",
      healthyMateRuntime({ files: baseFiles, unavailableFiles: [pgpass] }),
    );
    expect(reasonCodes(missingCredential)).toContain(
      "database_credential_unavailable",
    );

    const missingListener = yield* evaluate(
      environment,
      "ready",
      healthyMateRuntime({
        files: baseFiles,
        unavailableFiles: [coordinationState],
      }),
    );
    expect(reasonCodes(missingListener)).toContain(
      "coordination_listener_missing",
    );

    const listening = yield* evaluate(
      environment,
      "ready",
      healthyMateRuntime({
        files: {
          ...baseFiles,
          [coordinationState]: `${JSON.stringify({
            agentName: "firstmate",
            herdrSession: session,
            listenerProcessId: 9001,
            listenerTaskId: "bg-listener",
            ownerProcessId: processId,
            phase: "listening",
            version: 1,
          })}\n`,
        },
      }),
    );
    expect(reasonCodes(listening)).toContain("coordination_catchup_incomplete");

    const staleListener = yield* evaluate(
      environment,
      "ready",
      healthyMateRuntime({
        files: {
          ...baseFiles,
          [coordinationState]: `${JSON.stringify({
            agentName: "firstmate",
            herdrSession: session,
            listenerProcessId: 9001,
            listenerTaskId: "bg-listener",
            ownerProcessId: processId,
            phase: "caught_up",
            version: 1,
          })}\n`,
        },
        liveProcessIds: [],
      }),
    );
    expect(reasonCodes(staleListener)).toContain(
      "coordination_listener_missing",
    );

    const recovered = yield* evaluate(
      environment,
      "ready",
      healthyMateRuntime({
        files: {
          ...baseFiles,
          [coordinationState]: `${JSON.stringify({
            agentName: "firstmate",
            herdrSession: session,
            listenerProcessId: 9001,
            listenerTaskId: "bg-listener",
            ownerProcessId: processId,
            phase: "caught_up",
            version: 1,
          })}\n`,
        },
      }),
    );
    expect(recovered.status).toBe("ready");
    expect(recovered.reasons).toEqual([]);
  }));

  it.effect("reports a human-blocked live Mate as degraded without failing readiness", () => Effect.gen(function*() {
    const result = yield* evaluate(
      mateEnvironment(),
      "ready",
      healthyMateRuntime({
        commands: {
          [commandKey([
            "herdr",
            "agent",
            "explain",
            "firstmate",
            "--json",
            "--session",
            session,
          ])]: { exitCode: 0, stdout: '{"agent":"pi","state":"blocked"}\n' },
        },
      }),
    );
    expect(result.status).toBe("degraded");
    expect(reasonCodes(result)).toContain("agent_blocked");
  }));

  it.effect("distinguishes Crewmate harness, Assignment, brief, credential, and confirmation", () => Effect.gen(function*() {
    const crewCwd = "/workspace/assignment";
    const crewBrief = "# Complete brief\n";
    const briefPath = `${home}/brief.md`;
    const crewState = `${home}/.local/state/agentos/readiness/crewmate.json`;
    const crewAuth = `${home}/.codex/auth.json`;
    const crewEnvironment: HealthEnvironment = {
      HOME: home,
      AGENTOS_AGENT_CWD: crewCwd,
      AGENTOS_AGENT_ID: "00000000-0000-4000-8000-000000000003",
      AGENTOS_AGENT_NAME: "crewmate",
      AGENTOS_AGENT_ROLE: "crewmate",
      AGENTOS_ASSIGNMENT_ID: "00000000-0000-4000-8000-000000000005",
      AGENTOS_BRIEF_PATH: briefPath,
      AGENTOS_BRIEF_SHA256: sha256(crewBrief),
      AGENTOS_HARNESS: "codex",
      AGENTOS_PROVIDER_CREDENTIAL_KIND: "codex_auth",
      AGENTOS_TASK_ID: "00000000-0000-4000-8000-000000000004",
      HERDR_SESSION: "agentos-crewmate",
    };
    const crewCommands = {
      [commandKey([
        "herdr",
        "status",
        "--json",
        "--session",
        "agentos-crewmate",
      ])]: { exitCode: 0, stdout: '{"result":{"running":true}}\n' },
      [commandKey([
        "herdr",
        "agent",
        "list",
        "--session",
        "agentos-crewmate",
      ])]: {
        exitCode: 0,
        stdout: `${JSON.stringify({
          result: {
            agents: [
              {
                agent_session: { kind: "id", value: "codex-session" },
                agent_status: "working",
                cwd: crewCwd,
                foreground_cwd: crewCwd,
                name: "crewmate",
                pane_id: pane,
              },
            ],
          },
        })}\n`,
      },
      [commandKey([
        "herdr",
        "agent",
        "explain",
        "crewmate",
        "--json",
        "--session",
        "agentos-crewmate",
      ])]: { exitCode: 0, stdout: '{"agent":"codex","state":"working"}\n' },
      [commandKey([
        "herdr",
        "pane",
        "process-info",
        "--pane",
        pane,
        "--session",
        "agentos-crewmate",
      ])]: {
        exitCode: 0,
        stdout: `${JSON.stringify({
          result: {
            process_info: {
              foreground_process_group_id: processId,
              foreground_processes: [
                { argv0: "codex", cwd: crewCwd, pid: processId },
              ],
              pane_id: pane,
            },
          },
        })}\n`,
      },
    };
    const crewMarker = `${JSON.stringify({
      agentId: crewEnvironment.AGENTOS_AGENT_ID,
      assignmentId: crewEnvironment.AGENTOS_ASSIGNMENT_ID,
      briefSha256: sha256(crewBrief),
      harness: "codex",
      herdrSession: "agentos-crewmate",
      processId,
      taskId: crewEnvironment.AGENTOS_TASK_ID,
      version: 1,
    })}\n`;

    const ready = yield* evaluate(
      crewEnvironment,
      "ready",
      runtime({
        commands: crewCommands,
        files: {
          [briefPath]: crewBrief,
          [crewAuth]: "not-read-by-readiness",
          [crewState]: crewMarker,
        },
      }),
    );
    expect(ready.status).toBe("ready");

    const codexConfigPath = `${home}/.codex/config.toml`;
    const codexProviderMarker = `${home}/.local/state/agentos/codex-provider.json`;
    const codexEntry = {
      name: "AgentOS workload gateway",
      base_url:
        "http://agentgateway-openai.agentos.svc.cluster.local:8788",
      wire_api: "responses",
      supports_websockets: false,
      request_max_retries: 0,
      stream_max_retries: 0,
      env_http_headers: {
        "X-AgentOS-Assignment-Id": "AGENTOS_ASSIGNMENT_ID",
      },
      auth: {
        command: "/home/agent/.local/share/mise/shims/bun",
        args: [
          "/opt/agentos/packages/agentos/runtime/codex-token.ts",
          egressTokenPath,
        ],
        timeout_ms: 5_000,
        refresh_interval_ms: 60_000,
      },
    };
    const codexConfig = [
      'model_provider = "agentos-gateway"',
      "",
      "[model_providers.agentos-gateway]",
      'name = "AgentOS workload gateway"',
      'base_url = "http://agentgateway-openai.agentos.svc.cluster.local:8788"',
      'wire_api = "responses"',
      "supports_websockets = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
      'env_http_headers = { "X-AgentOS-Assignment-Id" = "AGENTOS_ASSIGNMENT_ID" }',
      "",
      "[model_providers.agentos-gateway.auth]",
      'command = "/home/agent/.local/share/mise/shims/bun"',
      `args = ["/opt/agentos/packages/agentos/runtime/codex-token.ts","${egressTokenPath}"]`,
      "timeout_ms = 5000",
      "refresh_interval_ms = 60000",
      "",
    ].join("\n");
    const gatewayCrewEnvironment = {
      ...crewEnvironment,
      AGENTOS_CODEX_PROVIDER_MODE: "ai-gateway",
      AGENTOS_RELEASE_ROOT: "/opt/agentos",
      AGENTOS_PROVIDER_CREDENTIAL_KIND: "ai_gateway",
      AI_GATEWAY_URL:
        "http://agentgateway-openai.agentos.svc.cluster.local:8788",
    };
    const gatewayCrewFiles = {
      [briefPath]: crewBrief,
      [crewState]: crewMarker,
      [codexConfigPath]: codexConfig,
      [codexProviderMarker]: `${JSON.stringify({
        _tag: "Active",
        entry: codexEntry,
        previousModelProvider: null,
        version: 1,
      })}\n`,
      [egressTokenPath]: "header.payload.signature",
    };
    const gatewayReady = yield* evaluate(
      gatewayCrewEnvironment,
      "ready",
      runtime({
        commands: crewCommands,
        files: gatewayCrewFiles,
        parseToml: () => ({
          model_provider: "agentos-gateway",
          model_providers: { "agentos-gateway": codexEntry },
        }),
      }),
    );
    expect(
      gatewayReady.checks.find(({ component }) => component === "provider"),
    ).toEqual({ component: "provider", status: "pass" });

    const driftedGateway = yield* evaluate(
      gatewayCrewEnvironment,
      "ready",
      runtime({
        commands: crewCommands,
        files: {
          ...gatewayCrewFiles,
          [codexConfigPath]: codexConfig.replace(
            "agentgateway-openai.agentos.svc.cluster.local",
            "unreviewed.example",
          ),
        },
        parseToml: () => ({
          model_provider: "agentos-gateway",
          model_providers: {
            "agentos-gateway": {
              ...codexEntry,
              base_url: "http://unreviewed.example:8788",
            },
          },
        }),
      }),
    );
    expect(reasonCodes(driftedGateway)).toContain(
      "provider_configuration_invalid",
    );

    const wrongDatabaseIdentity = yield* evaluate(
      {
        ...crewEnvironment,
        AGENTOS_DATABASE_IDENTITY: "another_identity",
        AGENTOS_DATABASE_URL:
          "postgresql://runtime_crewmate@postgres:5432/agentos?sslmode=require",
        PGPASSFILE: `${home}/.pgpass`,
      },
      "ready",
      runtime({
        commands: crewCommands,
        files: {
          [`${home}/.pgpass`]: "not-read-by-readiness",
          [briefPath]: crewBrief,
          [crewAuth]: "not-read-by-readiness",
          [crewState]: crewMarker,
        },
      }),
    );
    expect(reasonCodes(wrongDatabaseIdentity)).toContain(
      "database_identity_mismatch",
    );

    const wrongHarness = yield* evaluate(
      { ...crewEnvironment, AGENTOS_HARNESS: "claude" },
      "ready",
      runtime({
        commands: crewCommands,
        files: {
          [briefPath]: crewBrief,
          [crewAuth]: "not-read-by-readiness",
          [crewState]: crewMarker,
        },
      }),
    );
    expect(reasonCodes(wrongHarness)).toContain("harness_mismatch");

    const staleBrief = yield* evaluate(
      crewEnvironment,
      "ready",
      runtime({
        commands: crewCommands,
        files: {
          [briefPath]: "# stale\n",
          [crewAuth]: "not-read-by-readiness",
          [crewState]: crewMarker,
        },
      }),
    );
    expect(reasonCodes(staleBrief)).toContain("brief_digest_mismatch");

    const unavailableCredential = yield* evaluate(
      crewEnvironment,
      "ready",
      runtime({
        commands: crewCommands,
        files: { [briefPath]: crewBrief, [crewState]: crewMarker },
      }),
    );
    expect(reasonCodes(unavailableCredential)).toContain(
      "provider_credential_unavailable",
    );

    const unconfirmed = yield* evaluate(
      crewEnvironment,
      "ready",
      runtime({
        commands: crewCommands,
        files: {
          [briefPath]: crewBrief,
          [crewAuth]: "not-read-by-readiness",
        },
      }),
    );
    expect(reasonCodes(unconfirmed)).toContain(
      "crewmate_confirmation_missing",
    );

    const invalidAssignment = yield* evaluate(
      { ...crewEnvironment, AGENTOS_ASSIGNMENT_ID: "not-a-uuid" },
      "ready",
      runtime({
        commands: crewCommands,
        files: {
          [briefPath]: crewBrief,
          [crewAuth]: "not-read-by-readiness",
          [crewState]: crewMarker,
        },
      }),
    );
    expect(reasonCodes(invalidAssignment)).toContain(
      "assignment_identity_invalid",
    );
  }));
});
