# Second Mate Kubernetes assets

This subtree owns the reusable persistent Second Mate workload base.

- First Mate creates a reviewed per-agent overlay and invokes native kubectl.
- Patch the shared Pi lifecycle from `runtime/kubernetes/mate`; keep only
  Second-Mate identity, working directory, tasks and credentials here.
- Require a distinct ServiceAccount, retained home PVC, database identity and
  Herdr session for each Second Mate.
- Keep Second Mate on Pi while leaving Pi model and thinking settings on its
  agent-owned PVC.
- Never add a spawn/render wrapper or silently create RBAC and credentials.
- Test rendered Kubernetes semantics rather than YAML source text.
