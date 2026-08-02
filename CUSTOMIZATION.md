# Customize AgentOS

AgentOS uses Pi's native package system as its extension boundary. An
organization can load an ordinary Pi package beside the released behavior or
select a replacement package that owns the AgentOS entrypoint.

There is one released npm package:

| Package | Boundary |
| --- | --- |
| `@akua-dev/agentos` | Inert public TypeScript API plus the released Pi extension, Skills, role resources, runtime programs and Crewmate assets |

Importing the root API has no side effects. Pi activates behavior only when its
settings select the package extension or Skills. Neither action changes
PostgreSQL, Kubernetes, Herdr, Git, a PVC, credentials or provider state.

## Add or replace behavior

An **additive package** loads beside `@akua-dev/agentos`. Use it for independent
tools, commands, hooks or Skills that do not overlap a released owner.

A **replacement package** is selected instead of the released AgentOS
extension and supplies its own entrypoint. It may still depend on
`@akua-dev/agentos` and call public registration functions; importing those
functions does not activate the released extension. Released Skills can be
selected independently when they remain useful.

A **complete role replacement** also owns First- and Second-Mate instructions,
role-specific Skills, native Mise tasks, Kubernetes resources, Crewmate setups,
images and adjacent database or runtime materials. Changing a released
identity, authorization schema or core guarantee produces a custom AgentOS
distribution and must be identified and tested as such.

## Build on the public seam

A reusable ecosystem package can expose ordinary module exports and an optional
thin standalone Pi adapter:

```text
acme-agentos/
├── package.json
├── extensions/
│   └── standalone.ts
├── src/
│   └── index.ts
├── skills/
│   └── acme-startup/
│       └── SKILL.md
└── resources/
```

Declare supported AgentOS and Pi versions as peers:

```json
{
  "name": "@acme/agentos",
  "version": "1.0.0",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/standalone.ts"],
    "skills": ["./skills"]
  },
  "peerDependencies": {
    "@akua-dev/agentos": "^0.1.0",
    "@earendil-works/pi-ai": "0.81.1",
    "@earendil-works/pi-coding-agent": "0.81.1",
    "effect": "4.0.0-beta.102"
  }
}
```

Registration functions receive Pi explicitly and remain Effect programs:

```ts
import { Effect } from "effect";
import {
  buildAgentOSStartupPromptEffect,
  defineAgentOSPiCommandHandler,
  defineAgentOSPiExtension,
  registerAgentOSInstructionsEffect,
  registerAgentOSRuntimeEffect,
  registerAgentOSStartupEffect,
  type AgentOSRegistrationV1,
  type AgentOSStartupContributionV1,
} from "@akua-dev/agentos";

const runtime: AgentOSRegistrationV1 = {
  version: 1,
  id: "@acme/agentos:runtime",
  names: {
    version: 1,
    commands: ["acme-agentos-status"],
    messages: ["@acme/agentos:startup"],
  },
  register(pi) {
    return Effect.sync(() => {
      pi.registerCommand("acme-agentos-status", {
        description: "Inspect the Acme customization",
        handler: defineAgentOSPiCommandHandler((_arguments, context) =>
          Effect.sync(() =>
            context.ui.notify("Acme AgentOS is active", "info")
          )),
      });
    });
  },
};

const startup: AgentOSStartupContributionV1 = {
  version: 1,
  id: "@acme/agentos:startup",
  skill: "acme-startup",
  instruction: "Inspect the reviewed Acme state through native tools.",
};

export default defineAgentOSPiExtension((pi) =>
  Effect.gen(function*() {
    yield* registerAgentOSInstructionsEffect(pi, [{
      version: 1,
      id: "@acme/agentos:instructions",
      content: "Apply Acme's reviewed operating policy.",
    }]);
    yield* registerAgentOSRuntimeEffect(pi, [runtime]);
    const prompt = yield* buildAgentOSStartupPromptEffect([startup]);
    yield* registerAgentOSStartupEffect(pi, {
      customType: "@acme/agentos:startup",
      prompt,
      requiredSkills: [startup.skill],
    });
  })
);
```

Choose one loading path for each behavior: select its standalone adapter, or
import its registration function into another selected entrypoint. Never do
both. Several extensions may import AgentOS functions because the root API is
inert and stateless.

Use package-qualified identifiers and preflight every known tool, command,
Skill, custom message and persisted entry before registration. When ordering
matters or responsibilities overlap, select one owner and one explicit call
order. Extension load order is not an override mechanism.

## Let the model reconcile native state

An extension may react to `session_start`, send one bounded follow-up and tell
the model to load a delivered Skill. The Skill can inspect PostgreSQL with
`psql`, Kubernetes with `kubectl`, or Git and provider state through their
native tools. The prompt initiates judgment; it is not evidence that an
Assignment appeared, a migration ran or a workload changed.

Pi 0.81.1 emits `session_start` before extension `resources_discover` hooks.
Every startup Skill must therefore already be selected through the package
manifest or Pi settings. AgentOS validates that effective pre-session catalog
before triggering the turn.

AgentOS deliberately supplies no synthetic Assignment event, Fleet database
watcher, automatic migration service, second package registry or global SDK
singleton.

## Pi selection and process bootstrap are separate

Pi package selection plus a safe `/reload` can change extensions, injected
instructions, Skills and prompt resources. It cannot retroactively change the
Mise task, image, ServiceAccount, RBAC, Secret mounts or Kubernetes workload
that started the process.

A complete distribution therefore provides exact role directories:

```text
distribution/
├── extensions/agentos.ts
├── src/roles/
├── skills/
└── resources/
    ├── roles/
    │   ├── firstmate/
    │   │   ├── instructions.md
    │   │   ├── mise.toml
    │   │   └── kubernetes/
    │   └── secondmate/
    │       ├── instructions.md
    │       ├── mise.toml
    │       └── kubernetes/
    └── crewmates/
```

Persistent Mate workloads set `AGENTOS_DISTRIBUTION_ROOT` explicitly and set
`AGENTOS_AGENT_CWD` to the exact selected role directory. Native Kubernetes and
Mise apply pre-process changes while retaining the Mate home PVC. Pi settings
select the extension and Skills.

Pi-only rollback restores the prior package selection and reloads. Workload
rollback restores the prior image and Kubernetes resources. Neither claims to
reverse a separate database or provider change.

## Use the canonical workflow

Ask the responsible Mate:

```text
Load $agentos-customization. Help me design and apply a reviewed additive or
replacement Pi package for this AgentOS Fleet.
```

The canonical
[`agentos-customization` Skill](packages/agentos/skills/agentos-customization/SKILL.md)
owns inspection, staging, authorization, native selection, reload or rollout,
observable verification and rollback.
