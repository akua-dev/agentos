# Crewmate Kubernetes assets

This subtree owns the reusable separate-Pod Crewmate workload base.

- First or Second Mate creates a reviewed per-agent overlay and invokes native
  kubectl; Crewmates never create other agents.
- Require a distinct ServiceAccount, home PVC, database identity, selected
  image and pod-local Herdr session.
- Start the selected harness with its native command through Herdr only after
  the Pod and Assignment are verified.
- Do not add shared-pod execution, custom spawn/render wrappers or a
  release-wide harness/model/effort policy.
- Keep ArtifactFS out of this common base. An owning Mate loads
  `$agentos-artifact-fs`, selects the separate Scout image and reviews a
  platform-specific per-Agent FUSE overlay only for an eligible Scout.
- Test rendered Kubernetes semantics rather than YAML source text.
