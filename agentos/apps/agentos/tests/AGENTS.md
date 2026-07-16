# AgentOS app test contract

Test the real executable boundary and its observable behavior.

- Parse AXI TOON output and compare complete domain objects.
- Compare help text exactly only when that text is the public contract.
- Do not test that output or source files merely contain arbitrary strings.
- Use `toContain` only when membership or substring matching is itself the behavior under test.
- Verify exit status, structured failures, and side effects where they define behavior.
