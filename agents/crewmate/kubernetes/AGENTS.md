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
- Test rendered Kubernetes semantics rather than YAML source text.
