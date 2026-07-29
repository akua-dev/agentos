# Second Mate Kubernetes test contract

Exercise rendered workload behavior rather than YAML source text.

- Render the real Kustomize base with `kubectl kustomize`.
- Parse resources and assert identity, isolation, persistence and runtime semantics.
- Do not test that files merely contain selected strings.
