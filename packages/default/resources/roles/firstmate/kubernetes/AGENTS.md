# First Mate Kubernetes assets

This subtree owns only the persistent First Mate workload, its explicit
dedicated-cluster authority overlay and role-specific client wiring. Component
topology belongs with the component it deploys; First Mate's authority to
operate it belongs in RBAC and Skills, not in this directory's ownership.

- Keep resources declarative and renderable with native Kustomize and kubectl.
- Patch the shared Pi lifecycle from `runtime/kubernetes/mate`; keep only
  First-Mate identity, working directory, tasks and authority here.
- The base must remain namespaced and retain the agent home PVC.
- Cluster-admin is a separate, explicitly approved overlay.
- Do not encode provider, model or thinking defaults in Kubernetes resources.
- Do not add custom spawn/render programs or a second orchestration interface.
- Keep optional component manifests out of this subtree. PostgreSQL topology
  lives under `../../../database/kubernetes/`; service topology lives with the
  service under `../../../services/<name>/kubernetes/`.
- Keep an optional component's First-Mate-only client wiring as one additive
  native patch under `patches/`; it must preserve the live image, PVC, RBAC and
  unrelated Pod configuration. Its owning operational Skill decides when to
  apply it.
- `:dev` images are local contributor placeholders; published assets must use
  reviewed immutable image digests.
