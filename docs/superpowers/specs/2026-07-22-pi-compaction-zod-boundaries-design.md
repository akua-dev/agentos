# Pi Compaction Zod Boundaries Design

## Goal

Make the native Pi OpenAI server-compaction extension fail closed at every
untrusted JSON and session boundary without losing the forward-compatible
provider items and metadata that OpenAI requires callers to replay verbatim.

## Boundary model

Add Zod `4.4.3` as a direct, exactly pinned runtime dependency of the root
package. A focused schema module owns decoding for:

- JSON values and non-empty records;
- known Responses input/output items used by the extension;
- opaque future provider items;
- direct compact responses and Codex terminal/output-item SSE events;
- provider usage objects; and
- persisted native compaction state.

Every external value remains `unknown` only until `safeParse` succeeds. Parsed
values cross into the rest of the extension through schema-inferred types. No
production `as unknown as` assertion is permitted.

Known item schemas accept extra JSON properties so IDs and provider metadata
survive replay, but they validate every field the extension understands. The
opaque-item schema accepts a non-empty, JSON-safe object only when its `type`
is not one of the known discriminants. A malformed known item must therefore
fail instead of falling through to the forward-compatible branch.

## Internal types

Use a narrowed OpenAI Responses model type:

```ts
type OpenAIResponsesApi = "openai-responses" | "openai-codex-responses";
type OpenAIResponsesModel = Model<OpenAIResponsesApi>;
```

Give compaction tools, reasoning configuration, usage, direct compact bodies,
and Codex bodies named concrete types. Opaque provider metadata remains
JSON-safe data but is not exposed as if its fields were known. Pi's
`before_provider_request` payload remains `unknown` because that is the public
SDK contract; the extension parses the minimum object shape before rewriting
it.

## Data flow and failure behavior

The request builder operates only on typed internal data. Direct compact JSON
and each parsed SSE event are decoded before semantic checks such as terminal
status, unique artifact identity, and complete canonical-window preservation.
Persisted session state is decoded again when loaded rather than trusted
because it originated from an earlier process/version.

Any schema or semantic failure rejects remote compaction. The existing
extension boundary then retains Pi's successful portable local summary and
shows the existing warning when UI is available. This change does not weaken
timeouts, response-size limits, exact provider/model matching, gateway header
handling, or the one-artifact invariant.

## Tests

Use test-first regressions to prove:

- malformed known items cannot pass through the opaque schema;
- unknown future item types with nested JSON metadata are preserved exactly;
- non-JSON opaque values are rejected;
- malformed reasoning signatures no longer cross through a double assertion;
- malformed usage and persisted state fail closed or omit usage as specified;
- direct JSON and Codex SSE retain the complete canonical output window; and
- existing fallback, timeout, gateway, and session-replay behavior remains
  unchanged.

Run the focused compaction suite during each red/green cycle, then the complete
repository check with the repository-pinned Bun toolchain. Deliver the follow-up
through the existing PR #32 and its configured Luna/xhigh no-mistakes pipeline.

## Out of scope

Do not introduce an OpenAI SDK runtime client, replace native `fetch`, change
gateway routing, add WebSockets, depend on either reference extension, or claim
live-provider verification without a separately approved paid smoke test.
