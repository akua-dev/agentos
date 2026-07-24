# Shared persistent-Agent runtime boundary

This subtree contains Kubernetes mechanics shared by persistent Agents plus
executable lifecycle mechanics shared only by persistent First and Second
Mates. It is not an agent role and it is not an in-cluster CLI. Read the runtime
boundary in `../ARCHITECTURE.md` before changing its ownership.

- Implement only real container lifecycle behavior: persistent-home
  reconciliation, Herdr/Pi process supervision and Kubernetes health probes.
- Keep only retained-home, Pod-security, home-mount and role-neutral Mise/Herdr
  semantics in `kubernetes/base/`. Stateless workers do not inherit this base.
- Keep Pi and `mate:*` defaults shared by First and Second Mate in
  `kubernetes/mate/`. Role directories patch identity, working directory,
  tasks, credentials, harness selection and role-specific probes.
- Keep Captain policy, delegation judgment, model choice, thinking level and
  harness routing in role instructions and skills.
- Treat Pi settings and authentication as agent-owned PVC state. Never seed or
  reconcile a release-wide provider, model or thinking default. The
  `prepare-home` init step may merge an explicitly selected per-Mate
  `AGENTOS_MODEL=<provider>/<model>` and `AGENTOS_THINKING=<level>` into that
  state before Pi starts; omission preserves the existing settings.
- Use native tools directly. Do not add spawn, render or provider wrappers.
- Seed the image's exact Git revision once into the persistent AgentOS checkout,
  preserve its configured remotes, and run each Mate from that checkout.
- Build the image seed through `create-image-seed.ts`: require clean committed
  input, one shallow commit and credential-free remote URLs. Never copy the
  source repository's complete Git database into the final image.
- Do not copy AgentOS Skills or repository Mise files into parallel home mirrors.
  Preserve existing agent-owned settings, checkout state and files during
  preparation.
- Test observable runtime behavior against temporary homes and process
  boundaries; never test source-code strings.
