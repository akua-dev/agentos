# Shared Mate runtime boundary

This subtree contains executable mechanics shared by persistent First and
Second Mates. It is not an agent role and it is not an in-cluster CLI.

- Implement only real container lifecycle behavior: persistent-home
  reconciliation, Herdr/Pi process supervision and Kubernetes health probes.
- Keep the shared First/Second-Mate StatefulSet in `kubernetes/base/`; role
  directories patch identity, working directory, tasks and credentials.
- Keep Captain policy, delegation judgment, model choice, thinking level and
  harness routing in role instructions and skills.
- Treat Pi settings and authentication as agent-owned PVC state. Never seed or
  reconcile a release-wide provider, model or thinking default.
- Use native tools directly. Do not add spawn, render or provider wrappers.
- Preserve existing agent-owned settings and files during reconciliation.
- Test observable runtime behavior against temporary homes and process
  boundaries; never test source-code strings.
