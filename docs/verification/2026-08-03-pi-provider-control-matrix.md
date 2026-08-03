# Pi provider control-matrix evidence

## Deterministic integration result

On 2026-08-03 the Effect integration harness ran Pi `0.81.1` against one
local OpenAI-compatible provider fixture. The provider name, model, credential
class, prompt fixture and request behavior stayed fixed. The gateway comparison
changed only the base URL hostname so the AgentOS route contract classified it
as `ai_gateway`. No billable or production provider was called.

The run covered 18 evidence cells:

- three fresh and three resumed trials with the recorder extension discovered;
- three fresh and three resumed trials with discovery disabled and only the
  recorder explicitly loaded through `-ne -e`;
- three fresh direct-route and three fresh gateway-route control trials.

Every measured turn completed with exactly one `main` provider attempt,
`retryCount: 0`, the expected fresh/resumed and direct/gateway classification,
one W3C `traceparent`, and one matching AgentOS request-attempt identifier. The
evidence contained neither the deterministic prompt fixture nor the provider
credential. The deterministic fixture therefore rejects amplification caused
by the observability component itself and proves that retained sessions and the
`-ne -e` command shape remain measurable.

Run the repeatable matrix with:

```console
AGENTOS_RUN_PI_OBSERVABILITY_MATRIX=true bun ./node_modules/vitest/vitest.mjs run --no-file-parallelism packages/agentos/runtime/tests/pi-observability-control.effect.test.ts
```

## Live Fleet preflight

The available `orbstack` Fleet target was inspected read-only in namespace
`agentos`. `agentos-firstmate-0` was ready and ran Pi `0.81.1`, but its image
digest was `sha256:d1f5d58993012ae8b2fcd8190cca26190b4a4557989c12981e7191dcbc33e9e0`
from source revision `5b3e92d23c1ca7805d325c60758eeb8c06332c5e`. That revision predates the
standalone AgentOS observability extension and this implementation, so a live
normal-versus-`-ne -e` result from that pod would compare different
instrumentation and is invalid.

The pod retained multiple persistent Pi sessions, including a representative
multi-megabyte session. Those files were inspected only to establish retained
state and error presence; prompts, transcripts, provider bodies, credentials
and session identifiers were not copied into this evidence.

After an exact implementation image is deployed, rerun the canonical
`agentos-observability` Skill procedure with the same pod, model, route,
credential source, deterministic prompt and at least three trials per cell.
Until then the production extension-amplification and retained-session
hypotheses remain unconfirmed, not disproved.
