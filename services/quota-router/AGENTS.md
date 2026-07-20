# Quota router boundary

This package owns the optional Fleet-local AI request data plane and its private
credential/routing state.

Its `kubernetes/` directory owns the optional deployment shape. Runtime
semantics stay in this service package; operator judgment, approvals and
credential workflows stay in the shared quota-router Skill.

- Version one is Codex-subscription-first. Keep provider-specific behavior
  behind narrow adapters so another provider does not weaken Codex semantics.
- Authenticate before reading proxy request bodies. Strip inbound provider
  credentials and add only the selected upstream credential.
- Keep account selection deterministic, session stickiness explicit, and
  reservations renewable. Do not infer identity from source IP or user-agent.
- Do not retry a sent request against another account. Return the real upstream
  response synchronously so the harness owns recovery.
- Never store request or response bodies, full upstream errors, provider account
  IDs, OAuth tokens or API keys in routing state or logs.
- The OAuth vault is mode `0600` below a mode `0700` directory. The optional API
  key fallback stays outside the mutable vault and must be enabled explicitly.
- Keep the released topology single-replica until a reviewed transactional
  multi-replica authority replaces file state.
- Tests use mock upstreams and credentials. Real login and paid model traffic
  require separate explicit approval.
