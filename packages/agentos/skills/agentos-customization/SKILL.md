---
name: agentos-customization
description: Design, inspect, build, install, replace, verify or roll back trusted AgentOS customization delivered through Pi packages. Use when extending a deployed Fleet with Pi extensions, startup prompts, injected instructions, Skills, First- or Second-Mate role setups, Mise or Kubernetes resources, Crewmate setups, database migrations or runtime assets; resolving overlapping package ownership; or changing which AgentOS resources Pi loads.
---

# Customize AgentOS

Use Pi as the extension host and package registry. Do not add an AgentOS plugin
manager, installer, watcher, activation service or shadow package state.

A Pi package is trusted code with the hosting Agent's operating-system access.
Package installation is therefore an authority decision. PostgreSQL RLS,
Kubernetes RBAC, provider credentials and Git permissions remain the
consequence boundaries.

## Establish the boundary

1. Resolve the target Fleet, Agent, persistent home, working directory, Pi
   process, AgentOS release and package origin. Distinguish authoring a package
   from applying one to a live Mate.
2. Inspect the installed Pi build and its native package surfaces:

   ```console
   pi --version
   pi --help
   pi list
   ```

   Inspect selection with `pi config`. Do not print whole settings or
   authentication files merely to discover package state.
3. Identify the exact package source and immutable version, target Agents,
   requested changes, review owner, reload or rollout boundary and rollback.
   Availability is not trust.
4. Classify the change:
   - **additive package** loads beside the released AgentOS package;
   - **behavior replacement** supplies the selected AgentOS extension while
     reusing public `@akua-dev/agentos` functions when useful;
   - **complete role replacement** also supplies selected role Mise, image and
     Kubernetes resources; or
   - **custom distribution** changes released identity, authorization schema
     or another core guarantee and must not be represented as unmodified
     AgentOS.
5. Resolve the separate authority for package selection, Pi reload, database
   mutation, workload rollout and provider effects. One does not imply another.

## Understand the one AgentOS package

`@akua-dev/agentos` is both the public TypeScript API and the released Pi
package. Importing its root module is inert. Pi activates behavior only when
its native settings select the package extension or Skills.

The package owns:

```text
@akua-dev/agentos/
├── dist/                         public inert TypeScript API
├── extensions/agentos.ts        released Pi entrypoint
├── skills/                      Pi-discoverable Skills
├── runtime/                     distribution runtime programs
└── resources/
    ├── roles/
    │   ├── firstmate/           instructions, Skills, Mise, Kubernetes
    │   └── secondmate/          instructions, Mise, Kubernetes
    └── crewmates/default/       brief, image, Mise, Kubernetes
```

Pi package selection governs extensions and Skills. It does not select the
working directory, `mise.toml`, image, ServiceAccount, RBAC, Secret mounts or
Kubernetes resources that started the process.

## Build an ordinary Pi package

Use the selected Pi version's native manifest. Keep executable behavior in
extensions, conditional judgment in Skills and deterministic materials next
to the Skill that applies them.

```json
{
  "name": "@example/agentos-customization",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  },
  "peerDependencies": {
    "@akua-dev/agentos": "^0.1.0"
  }
}
```

A package may contain:

- Pi extensions, prompt resources and themes;
- instruction sources injected through reviewed Pi hooks;
- Skills with adjacent SQL, TypeScript, YAML or templates;
- `resources/roles/firstmate/` and `resources/roles/secondmate/` with native
  `mise.toml` and Kubernetes resources;
- named Crewmate setups, image selections and capability expectations; and
- independent programs used through their native interfaces.

The Pi manifest exposes Pi resources. Other files remain ordinary package
assets until an extension or explicitly loaded Skill uses them.

Use only public exports from the selected `@akua-dev/agentos` release. Never
deep-import private implementation paths. Declare the supported range as a
peer dependency, compile and test against an exact development dependency, and
let the deployed installation pin the concrete version.

Shared values must remain plain structural data. Do not use classes, symbols,
`instanceof` checks or process-global state to coordinate separately installed
packages.

Do not put credentials, tokens, private keys, signed URLs or secret file bodies
in package metadata, prompts, Skills, migrations, role setups or logs.

## Choose how behavior loads

An ecosystem package may expose reusable functions from its normal module root
and a thin Pi entrypoint for direct installation:

```text
package/
├── src/index.ts
├── extensions/standalone.ts
├── skills/
└── resources/
```

Choose one path for each behavior:

- **Standalone additive:** Pi selects the package directly when its tools,
  commands, hooks, Skills and lifecycle effects are independent.
- **Imported registration:** the selected owner imports the package's
  registration function and calls it from one extension when ordering or
  shared ownership must be explicit.
- **Replacement:** Pi selects the replacement extension and does not select the
  released AgentOS extension. The replacement may import inert public
  functions from `@akua-dev/agentos` without activating released behavior.

Namespace every tool, command, Skill, message, startup contribution and
persisted entry with its owning package. Installing a standalone entrypoint and
also importing that package's registration function creates duplicate
ownership; select one path.

Several independently loaded extensions may call public AgentOS functions.
Those functions remain inert until invoked, accept `pi` explicitly and keep no
cross-package singleton state.

If packages overlap always-present identity, instruction injection, startup
turns, supervision, background commands or another released responsibility,
select one owner and one explicit call order. Never use extension load order or
last-writer-wins registration as an override mechanism.

## Preflight registrations

Before attaching any Pi behavior:

1. Read required package resources without mutating external state.
2. Validate the explicit role and supported AgentOS and Pi versions.
3. Validate package-qualified registration and startup IDs.
4. Reject known collisions across tools, commands, Skills, messages and
   persisted entries.
5. Confirm every startup contribution names a Skill in the selected
   pre-session catalog.
6. Only then attach Pi handlers, tools and commands.

Use `preflightAgentOSRegistrations` for structural registration claims and
`registerAgentOSRuntime` only after the whole selected set passes. A collision
is a configuration error; do not rely on Pi's duplicate-name resolution or add
a deduplication registry.

Extension registration cannot roll back a database write, Kubernetes mutation,
spawned process, timer, filesystem change or other external effect. Never
perform those effects during module import or registration. Defer them to an
explicit command, tool invocation or model-guided Skill.

## Let the model reconcile startup

An extension may use `session_start` to prompt the model to inspect and
reconcile the package. Keep the prompt bounded and route judgment to one
delivered Skill:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildAgentOSStartupPrompt,
  registerAgentOSStartup,
  type AgentOSStartupContributionV1,
} from "@akua-dev/agentos";

const startup: AgentOSStartupContributionV1 = {
  version: 1,
  id: "@example/agentos:startup",
  skill: "example-agentos-startup",
  instruction: "Inspect and reconcile the reviewed customization.",
};

export default function registerCustomization(pi: ExtensionAPI) {
  registerAgentOSStartup(pi, {
    customType: "@example/agentos:startup",
    prompt: buildAgentOSStartupPrompt([startup]),
    requiredSkills: [startup.skill],
  });
}
```

Pi 0.81.1 emits `session_start` before extension `resources_discover` hooks.
Declare required startup Skills through the package manifest or native Pi
settings so they are already present in the effective Skill catalog.

Aggregate multiple accepted startup contributions into one bounded follow-up:

- at most 16 contributions;
- package-qualified `id` at most 128 characters;
- Pi-compatible `skill` at most 64 lowercase letters, numbers and
  non-consecutive hyphens;
- `instruction` at most 2048 UTF-8 bytes each; and
- at most 16384 UTF-8 bytes across instructions.

Preserve explicit input order. Reject duplicates and overflow rather than
truncating, splitting or triggering competing model turns.

The prompt starts a model turn. It does not prove a migration, package, role or
Assignment changed. Let the Skill inspect authoritative state through native
`psql`, `kubectl`, Git, filesystem, provider and Pi interfaces. Do not invent
Fleet events or add a database observer merely to make an SDK appear reactive.

## Customize role and Crewmate setup

Package-owned role and Crewmate assets are ordinary versioned resources.
Selection remains explicit:

- the workload's working directory selects the role Mise configuration;
- the immutable image or reviewed retained checkout supplies exact bytes;
- native Kustomize and `kubectl` select and apply the workload;
- the Agent row selects the harness;
- the Assignment brief defines the accepted outcome and constraints; and
- Pi settings select extensions and Skills.

Require `AGENTOS_DISTRIBUTION_ROOT` to identify the exact distribution and
`AGENTOS_AGENT_CWD` to identify its exact selected role directory. Do not derive
either from package discovery, database state or the current directory.

An organization package may replace First- or Second-Mate instructions,
role-local Skills, Mise tasks, Kubernetes overlays, Crewmate briefs and images.
Render and test those assets from the packed artifact. Installing the Pi
package alone does not activate pre-process resources.

Organization database changes belong in versioned SQL owned by the reviewed
package or fork. The applying Skill inspects migration state and invokes native
PostgreSQL tooling. Never auto-apply SQL from extension registration.

## Stage and test

1. Keep unreviewed package bytes outside active Pi discovery.
2. Pin an immutable version or Git revision. Use a local path only when its
   mutable ownership and rollback are explicit.
3. Test observable behavior against the exact Pi build: loaded resources,
   lifecycle messages, registered tools, cleanup and collision failure.
4. Pack the publishable artifact and install it into a clean fixture. Verify
   public imports, dependency closure, extensions, Skills, role resources,
   Mise tasks and rendered Kubernetes resources without the source worktree.
5. Preserve the current package selection and resolvable prior source for
   rollback. Do not create a parallel AgentOS activation record.

## Apply at a safe boundary

Installing, removing or enabling trusted code changes the Agent runtime. Load
`$agentos-harnesses` before changing or reloading a live Pi session.

For additive behavior:

1. Install the exact reviewed source with Pi's native command.
2. Use `pi config` to select only intended extensions and Skills.
3. At an idle turn boundary, invoke `/reload`.
4. Verify the exact live session.

For replacement behavior:

1. Stage and test the replacement before disabling anything.
2. Ensure Pi selects exactly one owner for each replaced behavior.
3. Select the replacement extension and deselect the released AgentOS
   extension. Select released Skills independently only when intended.
4. Invoke `/reload` at an idle boundary.
5. Verify the live catalog, injected instructions and lifecycle message count.
6. On failure, restore the prior Pi selection and reload.

For a complete role replacement:

1. Preserve the prior image, overlay, role directory and resumable Pi session.
2. Render the replacement Kustomize resources through native tooling. Verify
   image, PVC, working directory, Mise task, ServiceAccount, RBAC and Secret
   mounts.
3. Preview and apply the exact workload change with its separate authority.
4. Wait for the rollout and verify one Pi session from the selected role
   directory with retained home state.
5. On failure, restore the prior native workload resources and verify the
   retained source session. Reverting Pi selection alone does not revert a Pod.

## Verify

After install or rollback:

1. Re-run `pi list` and inspect `pi config` without exposing secrets.
2. Verify exact loaded extension and Skill paths and exactly one owner for each
   replaced behavior.
3. Observe the exact Herdr Agent across `/reload`; the existing Pi session must
   remain singular and usable.
4. Observe one bounded startup message and explicit Skill load when startup
   behavior is selected. Duplication or a prompt loop is failure.
5. For role resources, inspect the actual image, working directory, Mise
   configuration and rendered/live Kubernetes resources.
6. Query PostgreSQL, Kubernetes, Git and providers directly for claimed
   external effects. Extension session state is not authoritative evidence.
7. Record origin, version, selected resources, verification and rollback in the
   owning reviewed workflow without credentials.

## Fail closed

- Unreviewed or mutable origin without explicit acceptance: inspect only.
- Missing authority: stop before install, reload, migration or rollout.
- Unsupported Pi surface: use that exact build's documentation or stop.
- Missing public AgentOS export: use an independent extension or reviewed fork.
- Duplicate or unowned registration: correct selection before registration.
- Startup Skill absent from the pre-session catalog: do not trigger the turn.
- Import-time or registration-time external effects: reject the package.
- Incomplete packed artifact or unresolved dependency: do not install.
- Package selected but native role resources not selected: do not claim a role
  replacement.
- Verification failure: restore the prior native selection at the same
  authority boundary and report the first unverified state.
