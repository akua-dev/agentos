# codex-router workspace snapshot

This directory contains the reusable `core`, `codex`, and Bun persistence
packages from
[`akua-dev/codex-router`](https://github.com/akua-dev/codex-router).

- Upstream commit: `cd697d2cd93d5cbce8ed643253a0f3053dc3f046`
- Upstream source: [`cd697d2`](https://github.com/akua-dev/codex-router/commit/cd697d2cd93d5cbce8ed643253a0f3053dc3f046)
- Imported paths: `packages/core`, `packages/codex`, `packages/bun`
- License: MIT; see [`LICENSE`](./LICENSE)

These are workspace packages, not an AgentOS fork. Shared account selection,
session affinity, leases, response classification, persistent routing
transitions, Responses protocol, header sanitation, and transparent streaming
behavior must change in `codex-router` first. Refresh this snapshot from the
reviewed upstream commit and keep AgentOS changes limited to OAuth, quota
observations, protected diagnostics, OpenTelemetry, and deployment wiring.

The snapshot keeps the upstream Effect test suites intact. AgentOS runs the
portable suites with `bun run router:test` and the persistence suite with
`bun run router:bun:test`, separately from its service integration tests.
