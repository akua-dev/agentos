# First Mate runtime test contract

Test observable runtime behavior and rendered Kubernetes resources.

- Execute lifecycle scripts against temporary homes and fake process boundaries.
- Render Kustomize and compare structured resources.
- Build or inspect the resulting container when validating image behavior.
- Never assert that shell scripts, Dockerfiles, or YAML source merely contain
  arbitrary strings.
