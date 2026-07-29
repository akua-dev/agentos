# Default Second-Mate distribution resources

This subtree owns the default distribution's Second-Mate instructions, native
Mise tasks and Kubernetes assets. It is a contributor boundary, not the
running Second-Mate identity.

- Operational identity belongs only in `instructions.md` and is injected by
  the selected distribution entrypoint.
- Persistent Pi launches with context-file discovery disabled, so this file
  must not carry runtime identity or authority.
- Shared Mate Skills belong at the distribution's manifest-owned `skills/`
  root; add a role-only Skill here only when it is genuinely Second-Mate
  specific.
- Keep role-specific native workload identity, RBAC, credentials, working
  directory and task selection here while this distribution's shared Mate
  lifecycle stays under `runtime/kubernetes/mate/` and its executable lifecycle
  stays under `runtime/`.
- Test instruction injection, Skill discovery, Mise selection and rendered
  Kubernetes behavior through their public or native interfaces.
