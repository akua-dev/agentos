# Controlled runtime and extension matrix

Use this procedure when a Pi `-ne` session works but the ordinary AgentOS
session does not. The result identifies correlation, not causation, until it
repeats under paired conditions.

## Preflight

Record the same pod, same container, same model, same provider route, same
credential source, same working directory, image digest, Pi version, AgentOS
commit, extension catalog, and UTC time window. Confirm whether the target
session is fresh or resumed. Do not copy environment values, headers, prompts,
or account identities into the evidence.

Use a non-sensitive deterministic prompt fixture and run at least three trials
per cell. Do not use a production conversation as the fixture.

## Matrix

| Cell | Session | Extension mode | Required command shape |
| --- | --- | --- | --- |
| A1 | fresh | normal discovered set | ordinary Fleet Pi launch in a new session |
| A2 | resumed | normal discovered set | resume the exact recorded session |
| B1 | fresh | no discovery; observability only | `pi -ne -e /opt/agentos/packages/agentos/extensions/agentos-observability.ts` |
| B2 | resumed | no discovery; observability only | same command with the exact supported Pi resume selector |

If A fails and B succeeds repeatedly, add one reviewed extension at a time with
another `-e` argument. Keep observability loaded in every cell. Test Mate memory,
server compaction, background tasks, and supervision independently; do not
disable the AI Gateway while claiming to test only an extension.

To isolate route behavior, repeat the smallest failing A/B pair once through
the AI Gateway and once through a supported direct route. Keep model and
credential class constant; if that is impossible, label the comparison
confounded.

## Evidence table

Record only:

| Field | Value |
| --- | --- |
| trial cell and repetition | bounded identifier |
| UTC start/end | timestamps |
| trace ID / attempt ID | protected incident record only |
| runtime / route / request kind / model family | contract values |
| status class / error class / stream outcome | contract values |
| provider-attempt count | numeric |
| upstream-header / first-byte / stream duration | numeric |
| extension catalog hash | opaque protected value |
| result | success, failure, inconclusive |

## Interpretation

- A and B both fail at `ai-gateway.route.acquire`: investigate capacity,
  account eligibility, quota freshness, and Gateway routing.
- A and B acquire a route but fail before upstream headers: investigate
  authentication, transport, timeout, and Gateway/provider reachability.
- A fails while B succeeds, with identical route and repeated trials:
  extension interaction is supported as a hypothesis. Add extensions one at a
  time and compare provider-attempt counts and request kinds.
- Fresh succeeds and resumed fails in both modes: inspect session size,
  compaction attempts, and state-specific amplification.
- Direct succeeds while Gateway fails with otherwise paired conditions:
  inspect Gateway spans, stream/decompression outcomes, and lease release.
- Telemetry is absent while the request succeeds: investigate the SDK,
  Collector, queue, PVC, or backend; do not classify it as an AI outage.
- One successful `-ne` run is inconclusive.
