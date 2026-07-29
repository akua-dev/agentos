# Customize AgentOS

AgentOS is a Pi-native composition, not a second plugin framework. An
organization can install an ordinary Pi package beside the released behavior or
select a complete replacement distribution. The package can use every native Pi
extension API and, when useful, the public `@agentos/pi` helpers.

The released packages have distinct jobs:

| Package | Boundary |
| --- | --- |
| `@agentos/pi` | Inert public TypeScript registrations, defaults, structural contracts and collision preflight |
| `@agentos/default` | The replaceable released entrypoint, role compositions, instructions, Skills, Mise, Kubernetes and Crewmate resources |

Importing `@agentos/pi` has no side effects. Loading `@agentos/default` activates
only the Pi resources selected by Pi. Neither action changes PostgreSQL,
Kubernetes, Herdr, Git, a PVC, credentials or provider state.

## Add or replace

An **additive package** loads beside `@agentos/default`. Use it for independent
tools, commands, hooks or Skills that do not overlap a released owner.

A **replacement package** excludes the default executable entrypoint with Pi's
native package filters and supplies its own single entrypoint. It may retain
selected default Skills independently. Use explicit name claims and preflight
every known tool, command, Skill, custom message and persisted entry before
attaching behavior; extension load order is not an override mechanism.

A **complete distribution** additionally owns First- and Second-Mate
instructions, role-specific Skills, native Mise tasks, Kubernetes resources,
Crewmate definitions, images and adjacent database or runtime materials.
Changing a released identity, authorization schema or core guarantee is allowed,
but the result must be identified and tested as a custom AgentOS distribution.

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
└── skills/
    └── acme-startup/
        └── SKILL.md
```

Declare the supported library and Pi versions as peers when another
distribution will compose the package:

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
    "@agentos/pi": "^0.1.0",
    "@earendil-works/pi-ai": "0.81.1",
    "@earendil-works/pi-coding-agent": "0.81.1"
  }
}
```

Registration functions receive Pi explicitly and remain normal TypeScript:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  composeAgentOSStartupPrompt,
  registerAgentOSInstructions,
  registerAgentOSRuntime,
  registerAgentOSStartup,
  type AgentOSRegistrationV1,
  type AgentOSStartupContributionV1,
} from "@agentos/pi";

export const runtime: AgentOSRegistrationV1 = {
  version: 1,
  id: "@acme/agentos:runtime",
  names: { version: 1, commands: ["acme-agentos-status"] },
  register(pi) {
    pi.registerCommand("acme-agentos-status", {
      description: "Inspect the Acme customization",
      async handler(_arguments, context) {
        context.ui.notify("Acme AgentOS is active", "info");
      },
    });
  },
};

export const startup: AgentOSStartupContributionV1 = {
  version: 1,
  id: "@acme/agentos:startup",
  skill: "acme-startup",
  instruction: "Inspect the reviewed Acme state through native tools.",
};

export function registerAcmeAgentOS(pi: ExtensionAPI) {
  registerAgentOSInstructions(pi, [{
    version: 1,
    id: "@acme/agentos:instructions",
    content: "Apply Acme's reviewed operating policy.",
  }]);
  registerAgentOSRuntime(pi, [runtime]);
  registerAgentOSStartup(pi, {
    customType: "@acme/agentos:startup",
    prompt: composeAgentOSStartupPrompt([startup]),
    requiredSkills: [startup.skill],
  });

  // Ordinary Pi remains available beside AgentOS helpers.
  pi.on("tool_result", (event) => {
    // Observe only what this package explicitly owns.
  });
}
```

Choose one mode for a reusable behavior: load its standalone adapter, or import
its registration into a distribution entrypoint. Never do both. Cross-package
contracts are plain structural values; they do not depend on a shared singleton,
class, symbol or `instanceof` identity.

## Let the model reconcile native state

An extension may react to `session_start` or reload, send one bounded follow-up,
and tell the model to load a delivered Skill. The Skill can inspect PostgreSQL
with `psql`, render and inspect Kubernetes with `kubectl`, or use Git and
provider tools directly. The prompt initiates judgment; it is not evidence that
an Assignment appeared, a migration ran or a workload changed.

Pi 0.81.1 emits `session_start` before extension `resources_discover` hooks.
Therefore every `requiredSkills` entry must already be selected through Pi's
native package manifest or settings. `registerAgentOSStartup` verifies the
effective pre-session Skill catalog before it triggers the turn. A Skill
available only from an extension resource hook may still be role-specific, but
it cannot be the target of that startup turn.

AgentOS deliberately supplies no synthetic Assignment event, Fleet database
watcher, automatic migration service, package registry or global SDK singleton.
An extension that needs Assignment data uses its available native tools or an
independently reviewed client explicitly.

## Pi selection and process bootstrap are separate

Pi package selection plus a safe `/reload` can change extensions, injected
instructions, Skills and prompt resources. It cannot retroactively change the
Mise task, image, ServiceAccount, RBAC, Secret mounts or Kubernetes workload
that started the process.

A complete distribution therefore provides exact role directories, while the
deployment selects them before startup:

```text
distribution/
├── extensions/agentos.ts
├── composition/
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
`AGENTOS_AGENT_CWD` to that distribution's exact selected role directory. The
role's `.pi/settings.json` uses Pi's native package configuration for additive
or replacement selection. Persistent Pi launches with `--no-context-files`, so
only the selected extension injects operational identity; repository
`AGENTS.md` files continue to govern source changes.

Roll out native changes with the distribution's reviewed immutable image and
Kustomize resources while retaining the Mate home PVC. Rollback restores the
prior image and overlay. Pi-only rollback restores the prior package selection
and reloads. Neither rollback claims to reverse a separate database or
Kubernetes change.

## Use the canonical workflow

Ask the responsible Mate:

```text
Load $agentos-customization. Help me design and apply a reviewed additive or
replacement Pi package for this AgentOS Fleet.
```

The canonical
[`agentos-customization` Skill](packages/default/skills/agentos-customization/SKILL.md)
owns inspection, compatibility, staging, authorization, native selection,
reload or rollout, observable verification and rollback. Pack and test the
publishable artifact against the exact supported Pi build before live
selection; source-checkout tests alone do not prove a usable package.
