# Second Mate Kubernetes assets

This subtree owns the namespace-neutral persistent Second Mate workload base
and its reviewed managed-domain composition.

- First Mate creates one reviewed per-Agent overlay over `domain/`, selects the
  concrete namespace there and invokes native kubectl. The generic `base/`
  never selects a namespace.
- Patch the shared Pi lifecycle from this distribution's
  `packages/agentos/runtime/kubernetes/mate`; keep only Second-Mate identity,
  working directory, tasks and credentials here.
- Require a distinct ServiceAccount, retained home PVC, database identity and
  Herdr session for each Second Mate.
- Explicitly mount the kubelet-rotated projected ServiceAccount identity in
  every persistent Second-Mate Pod. Native in-cluster `kubectl` must use that
  identity; never substitute a separately minted bearer token as steady-state
  supervision authentication.
- Keep child authority out of `base/`. The `domain/` composition binds the
  Second Mate to namespaced Crewmate workload operations while withholding
  Namespace, Secret, RBAC, quota, LimitRange, NetworkPolicy and cluster-scoped
  mutation. First Mate owns those controls and is bound into the domain for
  supervision and repair.
- Keep the cluster-scoped CEL policies and bindings in `admission/`, separate
  from each namespaced `domain/` render. First Mate or the platform installs
  that bundle once; its binding selects only Namespaces carrying the reviewed
  Crewmate-admission label. Each domain owns its LimitRange, CPU/memory/object/
  retained-storage quota and that immutable selector label.
- Treat every Secret in a domain namespace as visible to its Second Mate because
  workload-create authority can mount it. Keep Fleet-root credentials in the
  core namespace.
- Keep domain ingress isolated to same-namespace Pods and leave egress open.
  Do not delete a domain Namespace while retained PVCs still require preservation.
- Keep Second Mate on Pi while leaving Pi model and thinking settings on its
  agent-owned PVC.
- Never add a spawn/render wrapper or silently create RBAC and credentials.
- Test rendered Kubernetes semantics rather than YAML source text.
