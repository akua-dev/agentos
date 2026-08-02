# ACP harness-control evaluation

Issue: [#126](https://github.com/akua-dev/agentos/issues/126)

Parent: [#122](https://github.com/akua-dev/agentos/issues/122)

Evaluated AgentOS revision: `d9b3a06fefd44779a9a8fde3bbba8ebd94925121`

## Decision

Do not change the default native Herdr path.

- Permit a **narrow, opt-in Codex ACP pilot** only after the durable
  one-writer lease, readiness transition, exact-session recovery, and pinned
  image work described below exists. The pilot candidate is
  `@agentclientprotocol/codex-acp@1.1.4` at commit
  [`921d466e`](https://github.com/agentclientprotocol/codex-acp/commit/921d466e3aaf747885e395e761cd74ad2d39cd96),
  forced through `CODEX_PATH` to the Fleet's exact Codex `0.144.5` binary.
- **Reject `pi-acp@0.0.33` as a production AgentOS custody layer.** It is a
  useful compatibility reference, but its private ACP-to-Pi session map,
  legacy ACP SDK line, incomplete client delegation, and process ownership are
  not suitable as a second session authority. A future Pi ACP path should be a
  narrow Effect adapter over Pi RPC that uses the native Pi session path as its
  only durable session reference.
- **Reject `acpx@0.13.0` as the production session manager.** Its queue owner,
  persisted session records, queued prompts, reconnect behavior, and fallback
  session creation overlap AgentOS and Herdr authority. It may be used only as
  a disposable conformance client with a temporary home, explicit adapter
  command, zero production state, and no provider credentials.

ACP is an exclusive control mode, not a sidecar writer. In ACP mode, Herdr owns
the adapter process, the adapter owns exactly one provider process, and no
native TUI may write the same provider-native session. Returning to native mode
must make the Pod not-ready, stop the adapter, verify its provider child exited,
and only then resume the exact native session through the normal Herdr path.

## Non-negotiable authority model

The current runtime starts Pi directly under Herdr and refuses duplicate named
Agents in [`run-mate.ts`](../../packages/agentos/runtime/run-mate.ts). The
operational rules in
[`agentos-harnesses`](../../packages/agentos/skills/agentos-harnesses/SKILL.md)
already make native Pi paths and Codex resume IDs authoritative. ACP must
preserve those rules:

1. PostgreSQL owns Agent and Assignment identity.
2. Herdr owns terminal/process custody and attach/recovery observation.
3. Pi session JSONL paths or Codex thread IDs own conversation continuity.
4. An ACP session ID is a correlation alias only. It cannot authorize a new
   session, replace a native reference, or contain a copied transcript.
5. At most one writer may be active. Ambiguous or duplicate observations fail
   closed and make the Agent not-ready.
6. No AgentOS ACP layer may persist a prompt queue or transcript.

The Effect contract in
[`acp.ts`](../../packages/agentos/src/harness-control/acp.ts) encodes the
metadata-only correlation, one-writer handoff ordering, exact-session fallback,
and typed permission/cancellation/tool/plan/error control events. It does not
start an adapter or change the released runtime.

## Pinned Fleet baseline

| Component | Exact Fleet version | Current role |
| --- | --- | --- |
| Pi | `@earendil-works/pi-coding-agent@0.81.1` | Persistent Mates and Pi Crewmates, launched natively under Herdr |
| Codex | `@openai/codex@0.144.5` | Codex Crewmates, launched natively under Herdr |
| Herdr | `0.7.3` | Process and terminal custody |
| Node | `24.16.0` observed | Candidate adapter runtime |
| ACP | Stable protocol version `1` | Negotiated protocol, not a session authority |

The ACP protocol source evaluated was the TypeScript SDK at
[`a601208b`](https://github.com/agentclientprotocol/typescript-sdk/commit/a601208b243ef0ebd1d618cfe64fb919389040ab).
Its baseline requires `session/new`, `session/prompt`, `session/cancel`, and
`session/update`; load, resume, close, list, delete, additional directories,
MCP transports, authentication, plan events, and other features are
capability-negotiated.

## Candidate provenance and runtime closure

| Candidate | Exact source/package | License | Locked production dependency closure observed from the source lock | Fleet compatibility |
| --- | --- | --- | --- | --- |
| Codex adapter | [`codex-acp` `v1.1.4`, `921d466e`](https://github.com/agentclientprotocol/codex-acp/commit/921d466e3aaf747885e395e761cd74ad2d39cd96), npm integrity `sha512-DzusIpGwlQwMWuHgJhU8FWMsyQvzjenB93IEzQATkdbNulo5Rd9GKOz8+B+/C9iWWxmyXgtgmjzaL+iRFyDryQ==` | Apache-2.0 | ACP SDK `1.2.1`, Codex `0.144.4` plus its platform binary, Zod `4.4.3`, `diff` `9.0.0`, `open` `11.0.0`, `vscode-jsonrpc` `9.0.1` and the small `open` platform helpers | The declared Codex range is `^0.144.4`; initialization and the auth boundary worked with Fleet `0.144.5` via `CODEX_PATH`. A provider-backed turn was deliberately not run with personal credentials, so this remains pilot compatibility, not release proof. `v1.1.5+` no longer matches Fleet `0.144.5`; current `v1.1.9` is generated against Codex `0.145.x`. |
| Pi adapter | [`pi-acp` `v0.0.33`, `1bfcb394`](https://github.com/svkozak/pi-acp/commit/1bfcb394088ed879db8fd936b570bb626017f878), npm integrity `sha512-vX9kY1tK14E72G4dBAx+RGCk/k7XPjTHls6dLUxA8WSkBav6B6JHuSBv3eusp50LCR/GTRsR2kIKsG0Z5jANzw==` | MIT | ACP SDK `0.26.0`, Zod `3.25.76`; Pi is an external command selected by `PI_ACP_PI_COMMAND` | It initialized and reached Pi's typed authentication boundary with Fleet Pi `0.81.1`. It does not advertise ACP resume/close/additional-directory support and remains on the old SDK line. |
| ACP client/session manager | [`acpx` `v0.13.0`, `47dc1c56`](https://github.com/openclaw/acpx/commit/47dc1c56b20da3c248a4a1b5c5106f52e65e6594), npm integrity `sha512-EdGgMx5osY4bNpVN+7dTTT67ZXsFqx/itl4QjGYTKH/Nzm3fqGmWL3E6FjRkVrlWRpiFnRNi+J1lxUJPie4lmg==` | MIT | ACP SDK `1.3.0`, Zod `4.4.3`, Commander `15`, `tsx` `4.23.1`, `skillflag` `0.2.1` | Its built-in commands select Pi `^0.0.31` and Codex adapter `^1.1.5`, so the default Codex path is incompatible with Fleet `0.144.5`. Explicit commands work for disposable evaluation only. |

Published semver ranges are not an acceptable production pin. A pilot image
must lock every package and integrity, include the reviewed adapter artifact,
and point at the already pinned Fleet provider binary. `npx`, `latest`, and a
runtime package resolver are forbidden in the released path.

## Negotiated capabilities

The following responses came from protocol `initialize` using an ACP SDK `1.3`
client and the exact Fleet provider binaries in an isolated home.

| Capability | Codex ACP `1.1.4` | Pi ACP `0.0.33` | Consequence |
| --- | --- | --- | --- |
| Auth | API key; logout advertised | `pi_terminal_login` advertised | AgentOS must prepare native credentials before launch; no adapter gets a second credential store. |
| Load | Yes | Yes | Both replay history to the client, but provider-native storage remains authoritative. |
| Resume without replay | Yes | No | Codex can wake by thread ID; Pi requires load and replay through its adapter. |
| List/delete | Yes/yes | Yes/yes | Delete is destructive and must remain outside automatic recovery. |
| Close | Yes | No | Pi teardown must stop the adapter and its Pi child at the process boundary. |
| Additional directories | Yes | No | Pi's exact Assignment workspace boundary must be established before launch. |
| Prompt content | Text, image, embedded context | Text and image; no audio or embedded context | Clients must adapt to advertised types and reject unsupported content. |
| MCP | HTTP yes; SSE/ACP no | HTTP/SSE no | `pi-acp` accepts but does not connect supplied MCP servers. |
| Permission | Codex shell/file/MCP approvals mapped | Pi extension `select`/`confirm` mapped; `input`/`editor` cancelled | Neither adapter may silently auto-approve beyond the reviewed Pod/harness policy. |
| Cancel | Turn interruption with cancelled stop reason | Pi abort plus queued-prompt clearing | Cancellation is typed control state and must be correlated to the exact session. |
| Tools/plans/errors | Rich typed updates, including plan and terminal events | Tool lifecycle and bounded adapter status messages | AgentOS stores only control metadata and telemetry, never copied prompt or transcript content. |

## Lifecycle findings

### Authentication and trust

Both adapters initialized without credentials and failed `session/new` with a
typed authentication-required response. This is desirable. They did not reuse
the real user home. Project trust is still a native harness concern: the exact
Assignment worktree and native provider configuration must be prepared before
Herdr starts the adapter. ACP `cwd` is not evidence that repository hooks or
project resources were reviewed.

### Create, load, prompt, events, and steering

Codex ACP starts Codex App Server. Its ACP session ID is the Codex thread ID;
`session/resume` calls native thread resume, and `session/load` reads the native
thread before emitting history. It translates shell, file, permission, MCP,
terminal, reasoning, plan, search, image, token, review, and subagent events.

Pi ACP starts `pi --mode rpc --no-themes`. It creates native Pi sessions and
maps ACP IDs in `~/.pi/pi-acp/session-map.json`; load switches to the native Pi
session and replays the conversation. It supports Pi steering/follow-up queues,
but this must not become an AgentOS prompt queue. The adapter's own map is
secondary and disposable. AgentOS recovery must start from the exact native Pi
path, never from that map alone.

### Wake, replacement, failure, and teardown

ACP does not replace Herdr's process custody. AgentOS must implement every
transition as a lease generation change:

```text
ready writer A
  -> mark not-ready
  -> stop writer A
  -> Herdr verifies A and its provider child exited
  -> start writer B with the exact same native session reference
  -> verify exactly one writer
  -> persist correlation/generation
  -> mark ready
```

If an ACP adapter disappears and Herdr observes zero writers, AgentOS may start
the native harness with the recorded Pi path or Codex thread ID. If the adapter
or child is still observed, fallback fails closed. Missing native state,
generation conflict, correlation mismatch, or multiple writers also fail
closed. Recovery must never fall back to `session/new`.

### Attachability

Herdr can own and observe an ACP adapter, but attaching to that pane exposes an
NDJSON protocol process and diagnostics rather than the provider's interactive
TUI. This is reduced operator attachability during ACP mode. The native path
remains the human recovery surface: perform the ordered handoff and resume the
exact provider-native session. Running an adapter beside a native TUI to retain
interactive attachment would create two writers and is forbidden.

## Empirical evidence

All probes used `/tmp` homes with empty auth files. No personal credential,
existing Herdr session, native session, or provider-backed model turn was used.

| Probe | Result |
| --- | --- |
| Codex ACP initialize | Protocol `1`; adapter `1.1.4`; capability response above; exact Fleet Codex `0.144.5` started through `CODEX_PATH`. |
| Codex ACP `session/new` | Typed `Authentication required`; cold invocation completed in `0.54s`; `/usr/bin/time -lp` reported `111,263,744` bytes max RSS for the outer disposable client invocation. |
| Pi ACP initialize | Protocol `1`; adapter `0.0.33`; capability response above; exact Fleet Pi `0.81.1` selected through `PI_ACP_PI_COMMAND`. |
| Pi ACP `session/new` | Started Pi RPC, reached typed native auth failure, and returned it through ACP; cold invocation completed in `0.86s`; outer disposable client reported `112,230,400` bytes max RSS. |
| Native Pi RPC control probe | `get_state` succeeded without a model turn in `0.71s` and returned a new native JSONL path; outer invocation reported `163,184,640` bytes max RSS. The RSS figures are not an aggregate process-tree benchmark and must not be used to claim ACP is cheaper. |
| Codex process topology after initialize | Disposable client -> Node adapter -> Codex Node launcher -> native Codex App Server. The adapter added one resident Node process (about `100,720 KiB` in the sample) beyond the provider launcher/binary; a production embedded client need not add the disposable client process. |
| Pi process topology | Adapter initialization adds one Node process. An authenticated active session would additionally own one Pi RPC child; the unauthenticated probe correctly tore that child down. |
| Codex adapter tests | `311` executed tests passed, `28` skipped across `40` files (`34` passed, `6` skipped). The separate provider E2E suite was not run. |
| Pi adapter tests | `95/95` tests passed, including load/replay, steering/follow-up, permission, cancel, tool events, session restore, and missing-auth behavior. |
| Production dependency audits | `npm audit --omit=dev` reported zero known vulnerabilities for each exact source lock at evaluation time. This is a snapshot, not a substitute for image scanning. |
| Shadow state probe | `acpx` created `~/.acpx/sessions/index.json`; `pi-acp` created `~/.pi/pi-acp/session-map.json`, even though auth prevented native session creation. Both were isolated and empty, but their existence confirms the authority-overlap risk. |

Provider-backed success rate, real tool latency, and long-turn cancellation under
Fleet credentials remain intentionally unproven. The upstream unit/component
suites and pre-auth control probes are green, but they do not justify a default
switch. A narrow pilot must measure those dimensions against the unchanged
native path using disposable Assignments and non-personal workload credentials.

## Pilot gates

Codex ACP may be piloted only when all of these are true:

- a durable one-writer lease is stored with Agent, Assignment, Herdr Agent,
  native session, mode, and generation correlation;
- the runtime implements and tests the Effect handoff plan rather than shell or
  Promise orchestration;
- Herdr owns the adapter process and verifies its Codex child lifecycle;
- readiness is false throughout handoff and ambiguous custody;
- `codex-acp@1.1.4`, its full dependency closure, and Codex `0.144.5` are locked
  in the image; no runtime downloads occur;
- auth and exact worktree trust use the existing native Agent-owned home;
- permission, cancellation, tool, plan, error, provider failure, and teardown
  events pass the typed conformance suite;
- adapter kill, Pod restart, client disconnect, stale lease, duplicate writer,
  and native fallback scenarios preserve the exact thread;
- native and ACP cohorts measure success, time-to-first-event, turn latency,
  resident resources, restart recovery, and operator recovery time;
- no default, existing Agent, or native session is silently migrated.

The Pi community adapter and `acpx` remain available only as disposable test
fixtures. A future Pi implementation should speak ACP at a narrow Effect
boundary, drive the already supported Pi RPC protocol, retain no independent
session map or prompt queue, and run under the same exclusive Herdr lease.

## Follow-through

- [#130](https://github.com/akua-dev/agentos/issues/130) should consume this
  decision in the protocol conformance suite.
- The runtime work that enables any pilot must remain dependency-ordered behind
  identity, runtime lifecycle, telemetry, and native session durability work in
  [#83](https://github.com/akua-dev/agentos/issues/83),
  [#98](https://github.com/akua-dev/agentos/issues/98),
  [#104](https://github.com/akua-dev/agentos/issues/104), and
  [#119](https://github.com/akua-dev/agentos/issues/119).
- A2A/PG LISTEN remains the inter-Agent message path. ACP controls a harness
  process; it is not a Mate-to-Mate coordination bus.
