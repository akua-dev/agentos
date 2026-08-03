# Pi provider Effect telemetry implementation plan

**Issue:** #60
**Base:** `d9629baf1f12e2c161c7027944d5a6aeb3a99be9`
**Constraint:** every AgentOS TypeScript path is Effect-native.

## Outcome

Finish privacy-safe Pi provider instrumentation for main turns and auxiliary
AgentOS AI calls. Every provider attempt must appear exactly once with a finite
request kind, retry number, safe outcome and W3C/AgentOS correlation, including
the observability-only `pi -ne -e` control. Telemetry initialization, recording
and export remain bounded and fail-open and cannot determine whether a Pi turn
succeeds.

## Design

- Keep Pi's supported `before_provider_headers`, `after_provider_response`,
  `message_end` and `agent_settled` hooks as the main-turn boundary. Serialize
  operation and attempt transitions with one Effect `Semaphore`, reset retry
  state per operation, and preserve idempotent terminal behavior.
- Bound every untrusted telemetry service Effect. A timeout, defect or typed
  failure falls back to inert operation/attempt handles. Normal OpenTelemetry
  export remains asynchronously batched by its runtime and never enters the
  response stream path.
- Convert only finite, recognized Pi failure metadata into owned synthetic
  error names. Never retain or export `errorMessage`, arbitrary response
  headers, prompt/content, tool data, credentials or provider bodies.
- Preserve the existing explicit observability entrypoint so `-ne` disables
  discovery without disabling evidence. Exercise it with real Pi print-mode
  launches against a deterministic local OpenAI-compatible fixture.
- Treat the documented matrix as a paired experiment, not a causal claim. Run
  at least three trials per fresh/resumed and discovered/observability-only
  cell, then repeat the smallest pair over direct and gateway-shaped routes.
  Record only the contract's bounded evidence fields.

## TDD sequence

1. Add failing extension tests for retries, concurrent/duplicate terminal
   events, 401, 429, 503, timeout, abort, unsafe headers/error bodies and a
   telemetry service that fails or never completes.
2. Add a table-driven matrix test for three repeated trials in each required
   session, extension and route cell. Assert one main attempt per provider
   request and finite request kinds without prompt leakage.
3. Implement the serialized bounded state machine and owned error classifier
   in the Pi telemetry module using Effect `Ref`, `Semaphore`, `Duration` and
   timeout/cause recovery.
4. Verify auxiliary tests distinguish `compaction`, `memory_extract`,
   `memory_consolidate` and `extension`, including correlation and terminal
   failure paths.
5. Run the actual Pi observability-only command shape and, where the selected
   Fleet pod can be tested without production conversation data, the canonical
   live controlled matrix. Keep pod/model/route/session/prompt and repetitions
   paired and report confounding explicitly.
6. Run focused tests, the Effect migration gate, package/full checks and
   `git diff --check`; then open a PR, require exact-head CI, merge, and require
   green default-branch CI before closing #60.

## Verification commands

```console
bun ./node_modules/vitest/vitest.mjs run --no-file-parallelism packages/agentos/src/telemetry/tests
bun ./node_modules/vitest/vitest.mjs run --no-file-parallelism packages/agentos/src/openai-server-compaction/tests packages/agentos/src/mate-memory/tests
bun run effect:check
bun run check
git diff --check
```
