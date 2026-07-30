# codex-router workspace snapshot

This directory contains the portable `core` and `codex` packages from
[`akua-dev/codex-router`](https://github.com/akua-dev/codex-router).

- Upstream commit: `75bed6131c91422cc56ef46b06d4fe2e6cf6f459`
- Package source commit: `76912ddc91d3c1ced0f6a86273bf80ba7bf91db8`
- Imported paths: `packages/core`, `packages/codex`
- License: MIT; see [`LICENSE`](./LICENSE)

These are workspace packages, not an AgentOS fork. Shared account selection,
session affinity, lease, Responses protocol, header sanitation, and transparent
streaming behavior must change in `codex-router` first. Refresh this snapshot
from the reviewed upstream commit and keep AgentOS changes limited to its OAuth,
quota, persistence, health, and OpenTelemetry adapters.

The snapshot keeps the upstream Effect test suites intact. AgentOS runs them
with `bun run router:test`, separately from its Bun-native integration tests.
