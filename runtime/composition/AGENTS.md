# Agent composition runtime boundary

This directory owns deterministic validation of the resolved setup selected
for one Agent. It does not own composition judgment, activation workflow,
company tooling or runtime capability installation.

- Composition shapes model intelligence through Markdown instructions and
  Agent Skills. Released material kinds are `instructions` and `skill`.
- A Skill is a directory whose semantic entrypoint is `SKILL.md`; references,
  assets and scripts may accompany it. Their presence does not grant execution
  authority.
- Mise configuration, CLIs, MCP servers, harness extensions, images,
  environment, credentials, provider access and Kubernetes RBAC are native
  runtime capabilities, not composition material kinds. Skills may teach a
  Mate how to arrange them under existing authority and through their native
  interfaces.
- `harness` is the only runtime choice understood by AgentOS. Every other
  resolved native knob—including model, effort, fast mode, compaction,
  context limits and image—is opaque JSON under `settings`. Validation proves
  only that `settings` is an object; the responsible Mate interprets and
  verifies it against the selected runtime.
- Keep the versioned top-level envelope closed. New runtime knobs belong under
  `settings`; a new generic guarantee requires a reviewed manifest version,
  not another convenience field.
- Keep `manifest-v1.schema.json` as the public runtime preflight document and
  the TypeScript type plus PostgreSQL validator behaviorally corresponding to
  it. Do not fork a company-specific manifest shape.
- Keep the manifest origin-neutral. New company storage, tool or harness
  choices must not require a new SQL enum, TypeScript union or AgentOS
  activation handler.
- Deterministic code may validate manifest structure, canonical manifest
  digests, safe paths and exact content digests. It must not discover origins,
  choose context, fetch
  repositories, stage or publish files, edit harness settings, install
  capabilities, call a harness reload command or maintain activation state.
- Stream material traversal and file hashing with bounded working memory.
  Validation must not retain every path or buffer a complete file merely to
  calculate its digest.
- PostgreSQL records the resolved setup. Native files, harness state and
  provider configuration remain in their existing authorities. The
  responsible Mate follows the composition Skill and observes the real
  runtime before claiming that a setup loaded or worked.
- A manifest is a non-secret artifact by contract. Do not add heuristic secret
  scanners that guess from field names, providers or URL syntax; credentials
  stay in their real native authority and never enter manifests or selected
  material.
- Before adding a new deterministic behavior, ask whether it enforces a
  generic safety or atomicity guarantee. If the answer depends on interpreting
  company intent or an external tool, express it in a Skill and leave the
  decision to the Mate.

Tests belong under `tests/` and exercise public behavior against temporary
material trees. Never assert that implementation source contains selected
strings.
