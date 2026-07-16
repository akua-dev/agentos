# AgentOS contributor boundary

This directory contains the implementation developers and contributor agents
change. You are contributing to AgentOS; you are not a running First Mate,
Second Mate or Crewmate merely because you inspect `../fleet/`.

- Keep executable entrypoints in `apps/` and importable implementation in
  `packages/`.
- Follow every nearer package or test `AGENTS.md`.
- Use the tools selected by this directory's `mise.toml` and invoke them by
  their ordinary names.
- Keep runtime policy in Fleet role instructions and skills. Implementation
  should provide deterministic mechanics without replacing model judgment.
- Do not add wrappers that merely rename `kubectl`, `psql`, Herdr, Treehouse,
  provider CLIs or coding harness commands.
- Test observable behavior. Tests that search source files for arbitrary
  strings are not accepted.
- Run the smallest relevant check while working and `bun run check` before
  handing off a complete change.

The canonical product architecture and repository map remain in
[`../README.md`](../README.md).
