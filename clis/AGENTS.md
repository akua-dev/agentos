# AgentOS CLI boundary

This subtree contains narrow executable primitives deliberately installed on
an AgentOS image's `PATH`. A command belongs here only when an existing native
tool does not provide the required primitive cleanly.
Read the repository placement rules in `../ARCHITECTURE.md` before admitting a
new command.

- Keep every CLI independently useful, composable and free of Agent judgment.
- Default to using reviewed native CLIs directly. Put always-applicable command
  boundaries and Skill triggers in the nearest `AGENTS.md`; put conditional
  raw-CLI workflows and judgment in one discoverable Skill. A command sequence
  that needs better guidance is a documentation problem, not by itself a reason
  to add a wrapper here.
- Use standard input, output, error, exit codes and native environment or
  configuration conventions. Never put credentials in arguments or logs.
- Do not wrap capable tools such as Git, `gh-axi`, `kubectl`, `psql`, Herdr or
  Mise merely to rename, sequence or hide them.
- Do not add orchestration policy, shadow state, a daemon, controller,
  background service or provider abstraction.
- Keep dependencies and behavior tests in the owning CLI package. Test the
  executable interface and failure behavior, not selected source strings.
- Installation on `PATH` is an explicit image decision. A workspace package or
  executable bit alone does not make a command part of an AgentOS release.
- Put reusable imported code in `packages/`, Pi integration in `agents/.pi/`,
  Mate lifecycle mechanics in `runtime/`, and conditional usage guidance in
  one Agent Skill.

## Qualification examples

- To create or recover an Agent workload, document the reviewed raw
  `kubectl kustomize`, `apply`, `diff`, `wait`, `exec` and `cp` flow in
  `$agentos-runtime`. Do not add an `agentos spawn` or manifest-render wrapper.
- To work with repositories, issues or pull requests, document direct Git and
  `gh-axi` use in `$agentos-projects`. Do not add an AgentOS project or provider
  CLI that renames those operations.
- To query or mutate Fleet state, document direct `psql` transactions and the
  released SQL Functions in `$agentos-database`. Do not add a CRUD facade or
  database service for Agents.
- To attach, inspect, steer or wait on a harness, document native Herdr commands
  in `$agentos-runtime` or `$agentos-supervision`. Do not add a terminal or
  session wrapper.
- To resolve and install reviewed tools, document ordinary tool invocation and
  native Mise configuration in `$agentos-runtime`. Do not add a second package
  manager or an AgentOS tool-install command.
- `pg-listen` qualifies because the required primitive is specifically “wait
  for one PostgreSQL notification, print it, and exit,” which `psql` does not
  expose as a clean non-interactive command. It adds no Fleet policy, interprets
  no payload and remains useful outside AgentOS.
- `composition-verify` qualifies because no native origin, filesystem or
  harness CLI can validate the shared versioned manifest, canonical manifest
  digest, exact selected material tree and absence of unselected context as one
  deterministic boundary. It never fetches, copies, installs, loads or
  activates material.

Before adding another CLI, document the missing native capability and reject
the addition if direct composition of reviewed tools already solves it.
