# Customize AgentOS

AgentOS is deliberately open to trusted customization. Pi remains the extension
host and package registry: an organization can install an ordinary Pi package
that adds to the released AgentOS behavior or supplies its own selected
distribution.

A customization package can deliver:

- Pi extension behavior, tools and lifecycle hooks;
- startup prompts and always-present instruction resources;
- Skills with adjacent SQL, TypeScript, YAML and templates;
- Crewmate compositions, image choices and capability requirements; and
- organization-specific database and runtime materials used through their
  native authorities.

Pi packages run with the hosting Agent's operating-system access. Installing one
is therefore a trusted-code decision. It does not enlarge PostgreSQL RLS,
Kubernetes RBAC, provider credentials, Git permissions or the Agent's recorded
authority.

## Add or replace

An **additive package** loads beside the released AgentOS resources. It is the
smallest choice when an organization needs another Skill, tool, integration,
startup check or other independent behavior.

A **replacement distribution** supplies one custom AgentOS extension
composition. On the current release, role-local files under
`agents/<role>/.pi/extensions` are auto-discovered, so Pi package toggles alone
do not remove the released executable owner. Before a safe `/reload`, require
either a reviewed distribution or fork that removes that owner, or an explicit
discovery change that does so; verify exactly one owner remains.
Released Skills may remain selected independently. A complete replacement may
also supply First- and Second-Mate Mise configuration, Kubernetes overlays and
an immutable workload image.

Prefer one exact Pi-discovered AgentOS entrypoint. Keep First- and Second-Mate
composition modules outside Pi's extension discovery and let the entrypoint
select exactly one from the explicit deployed role. Missing or unknown role
configuration must fail closed rather than load both.

The replacement can reuse only public composition functions actually exported
by its selected AgentOS release. Do not assume an example package name or API
exists, deep-import private implementation files or treat documentation as
proof of a runtime boundary. When a required public export is absent, use an
independent additive extension, maintain an exact reviewed AgentOS fork or stop
until the release provides the boundary.

Pi and workload selection are separate boundaries. `/reload` can replace
extensions, instructions, Skills and prompts. It cannot retroactively replace
the role `mise.toml`, image, ServiceAccount, RBAC, volumes or Kubernetes
configuration that started the current process. Those resources are selected
through native Mise and Kubernetes lifecycle, normally from an exact custom
distribution revision or image digest while retaining the Mate home PVC.

## Let the model reconcile it

Installation makes the package available. Its extension may react to Pi
startup or reload, inject selected instructions and send one bounded message
that tells the model to load a delivered Skill.

The model then inspects real state with `pi`, `psql`, `kubectl`, Git and other
native tools and decides whether anything needs to change. The extension does
not need a Fleet-state watcher, synthetic Assignment events, an AgentOS API
server or an automatic database migrator.

For an in-place distribution change, the Skill may guide the model through
rendering and applying the reviewed Kubernetes overlay, waiting for pod
replacement and verifying the resumed Herdr and Pi session. The extension
cannot perform this first-boot selection from inside a process that has not
started yet.

Package settings and a successful reload prove only what Pi selected. A
successful rollout proves only what Kubernetes observed. Verify Mise, database,
workload, provider and delivery effects through their actual authorities.

## Change every layer honestly

Organization packages may customize Pi behavior, instructions, Skills,
First- and Second-Mate Mise tasks and Kubernetes overlays, Crewmate setups,
database materials and runtime assets. A selected release's existing authority
still applies while it is installed. For example, a release whose permanent
operational role identity comes from a closer `AGENTS.md`, or whose startup
paths point at its own role directories, continues to use those files until a
reviewed distribution moves and verifies those boundaries.

Changing a released identity, authorization schema or another core guarantee
creates a custom AgentOS distribution. That is allowed, but the resulting Fleet
must not be represented as an unmodified released deployment. Test the changed
authority directly and retain an exact rollback.

## Use the canonical workflow

Ask the responsible Mate:

```text
Load $agentos-customization. Help me design and apply a reviewed additive or
replacement Pi package for this AgentOS Fleet.
```

The canonical
[`agentos-customization` Skill](agents/.agents/skills/agentos-customization/SKILL.md)
owns package inspection, authority checks, design, staging, native Pi
configuration, safe reload, verification and rollback. Persistent-Agent desired
composition remains owned by the linked `agentos-composition` workflow.
