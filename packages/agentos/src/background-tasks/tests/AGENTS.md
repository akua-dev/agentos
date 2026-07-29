# Pi background task test contract

Test public behavior with temporary files, real short-lived subprocesses,
controlled command starters and real Pi RPC discovery.

- Never assert that implementation files merely contain selected strings.
- Prove process ownership and authority boundaries through observed output,
  terminal events, process cleanup and Pi API calls.
- Keep tests bounded; every spawned process must exit or be killed by the test.
