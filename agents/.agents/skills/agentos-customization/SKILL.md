---
name: agentos-customization
description: Design, inspect, compose, install, replace, verify or roll back a trusted AgentOS customization delivered as a Pi package or complete distribution. Use when extending a deployed Fleet with one or more Pi extensions, startup prompts, injected instructions, Skills, First- or Second-Mate Mise and Kubernetes resources, Crewmate compositions, database materials or runtime assets; building or reusing an additive ecosystem package or replacement AgentOS distribution; resolving overlapping extension ownership; or changing which AgentOS resources Pi loads.
---

# Customize AgentOS

Use Pi as the extension host and package registry. Do not add an AgentOS plugin
manager, installer, watcher, activation service or shadow package state.

A Pi package is trusted code with the hosting Agent's operating-system access.
Package installation is therefore an authority decision, not harmless content
discovery. PostgreSQL RLS, Kubernetes RBAC, provider credentials and Git
permissions remain the consequence boundaries.

## Establish the exact boundary

1. Resolve the target Fleet, Agent, persistent home, working directory, Pi
   process, AgentOS release and intended customization origin. Distinguish a
   package being authored from a package being applied to a live Mate.
2. Inspect the installed Pi build and its native package surfaces before
   proposing commands:

   ```console
   pi --version
   pi --help
   pi list
   ```

   Use that exact build's package and extension documentation. Inspect resource
   selection with `pi config`; do not print an entire settings or authentication
   file merely to discover package state.
3. Identify the exact package source, revision or immutable version, target
   Agents, requested changes, review owner, Pi reload boundary, workload
   rollout boundary and rollback. Availability is not trust.
4. Classify the package:
   - **additive** loads beside the released AgentOS resources;
   - **Pi replacement** supplies the selected AgentOS composition entrypoint and
     disables the released executable entrypoint;
   - **complete replacement** also supplies selected role Mise, image and
     Kubernetes resources;
   - **custom distribution** changes released identity, authorization schema or
     another core guarantee and must not be represented as unmodified AgentOS.
5. For a persistent Mate, load `$agentos-composition` before changing desired or
   observed composition. Require its exact Captain authority and safe-boundary
   procedure. This Skill owns Pi-package customization, not persistent
   composition authority.

## Build one ordinary Pi package

Use the selected Pi version's native package manifest. Keep executable behavior
in extensions, conditional judgment in Skills and deterministic materials next
to the Skill that applies them.

```json
{
  "name": "@example/agentos-customization",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

A customization package may include:

- Pi extensions, prompt resources and themes;
- always-present instruction resources injected through reviewed Pi hooks;
- Skills with adjacent SQL, TypeScript, YAML, templates or composition assets;
- explicit `roles/firstmate/` and `roles/secondmate/` directories containing
  native `mise.toml` and Kubernetes resources;
- named Crewmate profiles, image selections and capability requirements; and
- independent programs used through their own native interfaces.

The Pi manifest exposes Pi resources. Other files remain ordinary package
assets until an extension or explicitly loaded Skill uses them.

Use only documented public exports from the selected AgentOS release. Never
deep-import a private implementation path and claim compatibility. Pi packages
have separate module roots; follow the installed Pi package rules for bundling
package dependencies. If a needed AgentOS export does not exist, choose an
independent extension, an exact reviewed AgentOS fork or stop. Documentation is
not proof that an import exists.

The composed-consumption API below is future architecture, not a current release
contract. It becomes usable only after a selected AgentOS release publishes a
documented `@agentos/pi` package, its public exports and its isolated-package
compatibility rules. Current releases without those public exports remain closed
to this path; use standalone additive behavior, an exact reviewed AgentOS fork or
stop.

In that future architecture only, declare the supported `@agentos/pi` range as
a `peerDependency` and use a compatible `devDependency` to compile and test the
package. Let the final distribution resolve and pin the concrete version.
Shared values must remain plain structural data. Do not use classes, symbols,
`instanceof` checks or process-global state to establish compatibility across
isolated package module roots.

Do not put credentials, tokens, private keys, signed URLs or secret file bodies
in package metadata, prompts, Skills, migrations, profiles or logs.

### Choose standalone or composed consumption

Let an ecosystem package expose reusable functions from its normal module
exports and, when useful, a thin Pi entrypoint for direct installation:

```text
package/
├── src/index.ts
├── extensions/standalone.ts
└── skills/
```

Choose exactly one consumption mode:

- **Standalone additive:** install the Pi package directly when its tools,
  commands, hooks, Skills and lifecycle effects are independent of released
  AgentOS behavior. Namespace every tool, command, Skill, message, startup
  contribution and persisted entry with its owning package.
- **Composed (future architecture only):** once the selected distribution
  publishes the documented `@agentos/pi` boundary, add the package as a pinned
  dependency, import its registration functions into the one AgentOS composition
  entrypoint and include only its intended Skills through the distribution's Pi
  manifest. Do not expose its standalone entrypoint. Current releases without
  that boundary remain closed to composed consumption.

Use the future composed mode whenever ordering matters or the package overlaps
always-present identity, instruction assembly, startup turns, supervision,
background commands or another released responsibility. Select one owner for
each overlapping behavior; never use extension load order or last-writer-wins
registration as an override mechanism.

In that future architecture, several independently loaded extensions may call
`@agentos/pi` functions. Public AgentOS functions must remain stateless, accept
`pi` explicitly and use plain structural values so separate Pi package module
roots do not need shared singletons, symbols or `instanceof` identity.

When several future-composed packages require startup judgment, let them export
this small, versioned structural value:

```ts
export type AgentOSStartupContributionV1 = {
  version: 1;
  id: string;
  skill: string;
  instruction: string;
};
```

Use a package-qualified `id` and Skill name. Before registration or triggering,
the distribution validates the version, rejects duplicate IDs and rejects the
whole composition when any of these limits are exceeded:

- at most 16 contributions;
- `id` at most 128 characters;
- `skill` at most 128 characters;
- `instruction` at most 2048 UTF-8 bytes per contribution; and
- at most 16384 UTF-8 bytes across all `instruction` fields.

It preserves the explicit input order and aggregates the accepted instructions
into one bounded `session_start` follow-up. Reject overflow rather than
truncating or splitting it. Do not let each dependency trigger a competing
model turn merely because it was imported. Keep this descriptor limited to
startup aggregation; tools, commands and other Pi behavior remain ordinary
registration functions.

Do not rely on Pi's duplicate-name resolution. The selected Pi build may keep
the first registration across extensions while a later registration replaces
an earlier one inside one extension, without producing the ownership decision
the distribution intended. Preflight package compatibility, required
resources, startup contribution IDs and every known tool, command, Skill,
message and persisted-entry name before attaching handlers. Treat a collision
as a composition failure rather than using load order as configuration.

Installing a standalone adapter while also importing its registration function
creates duplicate ownership. Treat that as a configuration failure: restore
one selected mode and verify the Pi catalog, registered tool and command names,
instruction assembly and lifecycle message counts. Do not add an AgentOS
extension registry or deduplication singleton to conceal the conflict.

### Separate Pi load from process bootstrap

Pi package selection activates extensions, instructions, Skills and prompts.
It does not activate the `mise.toml`, image, ServiceAccount, RBAC, Secret mounts
or Kubernetes resources that started the current process.

A complete distribution can ship those materials, but their selection remains
native:

- the workload's explicit working directory selects the role Mise
  configuration;
- the immutable image or reviewed retained checkout supplies the exact
  distribution bytes;
- native Kustomize and `kubectl` select and apply the workload; and
- Kubernetes replacement starts Pi from the newly selected distribution while
  retaining the Mate home PVC.

Inspect the selected release before proposing this path. If its bootstrap
hard-codes released role directories and exposes no distribution-root
configuration, use a reviewed organization fork or independent Kubernetes
overlay. Do not claim that installing a Pi package changed pre-start state.

### Keep the model in charge

An extension may react to Pi startup and prompt the model to reconcile the
package. Keep the prompt bounded and route judgment to one delivered Skill:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function registerCustomization(pi: ExtensionAPI) {
  pi.on("session_start", (event) => {
    if (event.reason !== "startup" && event.reason !== "reload") return;

    pi.sendMessage(
      {
        customType: "example-agentos-startup",
        content:
          "Load $example-agentos-startup and reconcile its reviewed customization.",
        display: true,
        details: {},
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });
}
```

Declare the named Skill through the package's native Pi resources so it is
available before the prompted turn. Prevent recursive or unbounded follow-ups.
The default AgentOS startup hook should be a public configurable registration
function when the selected release supports that contract; a replacement may
then reuse it with a different prompt.

The prompt starts a model turn. It does not prove that a migration, package,
role or Assignment changed. Let the Skill inspect authoritative state with
native `psql`, `kubectl`, Git, filesystem and Pi interfaces and decide what is
needed. Do not manufacture Fleet events or add a database observer merely to
make an SDK appear reactive.

### Keep extension load transactional

Resolve and validate the complete in-process composition before registering it:

1. Read required package resources without mutating external state.
2. Validate the explicit role and supported AgentOS and Pi versions.
3. Validate startup contribution versions and package-qualified IDs.
4. Reject known naming or ownership collisions.
5. Only then attach Pi handlers, tools and commands.

When the selected Pi build discards a failed extension factory, this ordering
also discards its locally collected registrations. It cannot roll back a
database write, Kubernetes mutation, spawned process, timer, filesystem change
or other external side effect. Never perform those effects during module import
or registration. Defer them to an explicit command, tool invocation or
model-guided Skill and verify them through their native authority.

### Keep non-Pi authorities native

- Put organization database changes in versioned SQL owned by their reviewed
  origin. Let the applying Skill inspect migration state and invoke native
  PostgreSQL tooling. A change to released AgentOS guarantees belongs in an
  organization fork with SQL behavior tests, not an auto-applied package hook.
- Express Crewmate setups as exact composition materials and capability
  requirements. Load `$agentos-composition` to resolve and apply them.
- Treat image, environment, credential, provider and RBAC changes as separate
  native authorities. Selecting a Skill or package does not grant them.
- On a release whose operational role identity still comes from a closer
  `AGENTS.md`, that file remains authoritative. Replace it only through the
  reviewed organization fork. Use extension-injected role resources only when
  the selected release actually exposes and verifies that boundary.

## Stage before discovery

1. Develop the package in its own reviewed Git origin or an Agent-owned local
   path. Keep it outside active Pi discovery until its source, dependencies,
   instructions, Skills and executable hooks have been inspected.
2. Pin an immutable package version or Git revision for a stable Fleet. A local
   path is appropriate for private iteration only when its mutable ownership and
   rollback are explicit.
3. Test extension behavior against the exact supported Pi build. Test public
   behavior—loaded resources, lifecycle messages, registered tools and cleanup—
   rather than searching implementation files for strings.
4. Pack the publishable artifact and install that artifact into a clean
   fixture. Verify that its manifest includes the intended extensions, Skills,
   internal resources, composition modules and complete-distribution assets;
   that bundled dependencies resolve under Pi's isolated package loading; and
   that internal startup resources are not exposed as user prompt templates.
   Passing tests against the source checkout alone is insufficient.
5. Preserve the currently selected package configuration and resolvable package
   source for rollback. Do not create a parallel AgentOS activation record.

## Apply at a safe boundary

Installing, removing or enabling trusted code changes the Agent runtime. Obtain
the exact authority selected above before invoking Pi's native mutation
commands. Load `$agentos-harnesses` before changing or reloading the live Pi
session; this Skill retains package-selection judgment while the harness Skill
owns the verified native lifecycle.

### Add behavior

1. Install the exact reviewed source with the selected Pi build's native
   `pi install` form.
2. Use `pi config` to confirm only the intended extensions, Skills, prompts and
   themes are enabled.
3. At an idle turn boundary, invoke Pi `/reload`.
4. Verify the exact live session before treating the package as active.

### Replace AgentOS behavior

1. Stage and inspect the replacement distribution before disabling anything.
   Expose one exact AgentOS entrypoint in the Pi manifest. Keep First- and
   Second-Mate composition modules outside Pi's extension discovery, select
   exactly one from the explicit deployed role and fail closed when that role
   is missing or unknown. Assemble default, reused and custom behaviors through
   public registration functions rather than patching an already loaded
   extension.
2. Install the replacement package.
3. Do not assume `pi config` can disable a released executable role resource. In
   the current release, files under `agents/<role>/.pi/extensions` are
   auto-discovered, so package toggling alone can leave the released handlers
   active beside the replacement. Require a reviewed distribution or fork, or
   an explicit discovery change that removes the released executable owner from
   the selected role's discovery path before reload. Use `pi config` only for
   resources the exact Pi build documents as configurable. Retain released
   Skills only when the intended composition still selects them, and fail closed
   unless effective discovery verifies exactly one owner for every replaced
   behavior.
4. Invoke `/reload` at an idle turn boundary. Do not hot-patch the running
   extension instance or start a second Pi writer for the same home.
5. Verify the replacement. If verification fails, restore the prior package
   selection and reload before changing desired composition.

Pi configuration is the native loaded-resource authority. A PostgreSQL
composition row records desired Agent setup but does not prove what Pi loaded.

### Replace a complete Mate distribution

Use this only when the requested change includes role Mise, image or Kubernetes
configuration:

1. Stage the exact reviewed distribution and its rollback source before
   changing the running workload. Prefer an immutable image digest for a stable
   deployment; a retained mutable checkout is a development boundary.
2. Inspect and render the distribution's Kustomize overlay through native
   Kubernetes tooling. Require it to retain the intended home PVC and select
   the exact role working directory, Mise task, identity, ServiceAccount, RBAC,
   credentials and image.
3. Verify the current context, namespace, workload, image and PVC. Obtain the
   separate authority required for the workload change.
4. Apply the reviewed overlay and wait for the exact rollout. Do not use Pi
   `/reload` as a substitute for a pod lifecycle change.
5. Through the real Herdr Agent, verify that the singular Pi session resumed
   from the retained home and loaded the intended distribution resources.
6. If verification fails, restore the prior image and overlay through native
   Kubernetes tooling, then verify the same retained session. Reverting Pi
   package selection alone does not revert a workload change.

## Verify observable behavior

After install or rollback:

1. Re-run `pi list` and inspect `pi config` without exposing secrets.
2. Require Pi's native loaded-extension and Skill catalog to resolve the exact
   intended package paths and exactly one owner for each replaced behavior. A
   successful install command or present file is not enough.
3. Observe the exact Herdr Agent across `/reload`. Require the existing Pi
   session to remain singular and usable.
4. If the package defines startup behavior, observe one bounded custom message
   and the model's explicit Skill load. Absence, duplication or a prompt loop is
   a failure.
5. For a complete distribution, inspect the actual container image, working
   directory, native Mise configuration and rendered Kubernetes resources.
   Package presence is not evidence that any of them was selected.
6. Query PostgreSQL, Kubernetes, Git and providers directly for any external
   effects the model claims. The startup prompt and extension session state are
   never authoritative evidence.
7. Record the exact package origin, version, selected resources, verification
   and rollback in the owning reviewed workflow. Never record credentials.

## Fail closed

- Unreviewed or mutable origin without explicit acceptance: inspect only.
- Missing Captain authority: stop before install, configuration or reload.
- Unsupported Pi package or lifecycle surface: use that build's documentation
  or stop; do not guess settings JSON.
- Missing public AgentOS export: use an independent extension or reviewed fork;
  do not deep-import internals.
- Released role executable remains in auto-discovery or exactly one replacement
  owner cannot be proven: require a reviewed distribution or explicit discovery
  change before reload.
- Incompatible `@agentos/pi` peer range or startup contribution version: fail
  composition before registration.
- Duplicate package-qualified identifier or Pi resource name: fail composition;
  do not choose an owner by extension order.
- Ambiguous duplicate extension ownership: restore the last verified selection.
- Startup Skill unavailable: do not trigger the model turn.
- Migration or external-state ambiguity: inspect the native authority; never
  infer success from package state.
- Reload failure: restore the prior Pi resource selection and verify the exact
  session.
- Role Mise or Kubernetes change requested through Pi reload alone: stop and
  separate the native workload rollout.
- Distribution loaded in Pi but not selected by the running workload: report a
  partial mismatch; do not claim complete replacement.
- Changed core guarantee: identify the Fleet as a custom distribution and test
  the changed authority directly.
