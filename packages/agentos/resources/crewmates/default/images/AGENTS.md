# Crewmate image boundary

This subtree contains optional task-specific Crewmate images, never the common
First- and Second-Mate runtime.

- Keep each image additive and independently selectable by exact digest.
- Do not add its tools or privileges to the root AgentOS image.
- Build from exact upstream versions and an exact reviewed AgentOS base image.
- Keep runtime permissions in a reviewed per-Agent Kubernetes overlay; an image
  must not imply that a cluster supports its kernel or device requirements.
- Validate the executable in the built image and lifecycle-test privileged
  kernel interfaces on the selected disposable platform before use.
