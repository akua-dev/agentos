# First Mate Kubernetes assets

This subtree owns the persistent First Mate workload, its explicit
dedicated-cluster authority overlay and optional self-hosted database topology.

- Keep resources declarative and renderable with native Kustomize and kubectl.
- Patch the shared StatefulSet from `fleet/runtime/kubernetes/base`; keep only
  First-Mate identity, working directory, tasks and authority here.
- The base must remain namespaced and retain the agent home PVC.
- Cluster-admin is a separate, explicitly approved overlay.
- Do not encode provider, model or thinking defaults in Kubernetes resources.
- Do not add custom spawn/render programs or a second orchestration interface.
- `:dev` images are local contributor placeholders; published assets must use
  reviewed immutable image digests.
