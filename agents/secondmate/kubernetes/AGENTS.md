# Second Mate Kubernetes assets

This subtree owns the reusable persistent Second Mate workload base.

- First Mate creates a reviewed per-agent overlay and invokes native kubectl.
- Patch the shared Pi lifecycle from `runtime/kubernetes/mate`; keep only
  Second-Mate identity, working directory, tasks and credentials here.
- Require a distinct ServiceAccount, retained home PVC, database identity and
  Herdr session for each Second Mate.
- Explicitly mount the kubelet-rotated projected ServiceAccount identity in
  every persistent Second-Mate Pod. Native in-cluster `kubectl` must use that
  identity; never substitute a separately minted bearer token as steady-state
  supervision authentication.
- Keep child access out of this reusable base. The reviewed per-Agent overlay
  owns least-privilege Role and RoleBinding resources for exact managed child
  Pod names; never grant label-wide or sibling access here.
- Keep Second Mate on Pi while leaving Pi model and thinking settings on its
  agent-owned PVC.
- Never add a spawn/render wrapper or silently create RBAC and credentials.
- Test rendered Kubernetes semantics rather than YAML source text.
