# AgentOS benchmark results

AgentOS does not ask readers to infer organizational reliability from a polished
demo. Version `0.1.0` publishes every declared attempt, exact subject revision,
hard-gate verdict and immutable sanitized evidence bundle.

This page is the human-readable report. The versioned
[`quickstart-to-delivery-v0.1.0.json`](./quickstart-to-delivery-v0.1.0.json)
manifest is the source of truth for the five-attempt baseline. If prose and the
manifest ever disagree, the manifest and its referenced immutable evidence win.

## What was demonstrated

| Claim | Evidence |
| --- | --- |
| A fresh AgentOS Fleet can reach an independently verified review artifact. | Three of five declared Quickstart attempts passed every applicable outcome, ownership, accountability and safety gate. |
| It can do so without turning the Captain into the orchestration loop. | The final two passes each required zero principal follow-up turns, decisions, avoidable clarifications, repair interventions and manual operational actions. |
| Accepted work can survive worker loss. | The held-out recovery retained the same Agent, Task, Assignment, PVC, worktree, file and native Codex session, then delivered one verified review artifact. |
| Failure can improve the organization without rewriting history. | The incomplete pilot stayed frozen, produced one falsifiable supervision change, and was followed by two passing counterfactual reruns plus a passing held-out recovery. |
| The benchmark is not an AgentOS compatibility test. | A native Codex CLI run passed the portable scenario without AgentOS, PostgreSQL, Kubernetes or Herdr. |

## Quickstart-to-delivery baseline

The subject was AgentOS `v0.1.4` at source revision
`8760e5e18d5d1c7478171539236526cfc90e4ae7`. Every row belongs to the declared
run set; the failed and incomplete attempts are not discarded.

| Attempt | Verdict | Seed to delivery | Captain turns | Repair interventions | Manual operations | What happened |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| [01](https://github.com/akua-dev/agentos/releases/tag/benchmark-v0.1.0-agentos-quickstart-01) | Failed | 70m 31s | 2 | 2 | 0 | A review artifact existed, but the outcome and complete-chain evidence gates failed. |
| [02](https://github.com/akua-dev/agentos/releases/tag/benchmark-v0.1.0-agentos-quickstart-02) | Passed | 30m 11s | 3 | 2 | 2 | First complete passing path, with visible human repair cost. |
| [03](https://github.com/akua-dev/agentos/releases/tag/benchmark-v0.1.0-agentos-quickstart-03) | Incomplete | Unobserved | 0 | 0 | 0 | The evaluator rejected an invalid starting state before crediting a Fleet run. |
| [04](https://github.com/akua-dev/agentos/releases/tag/benchmark-v0.1.0-agentos-quickstart-04) | Passed | 16m 59s | 0 | 0 | 0 | Counterfactual rerun passed without Captain follow-up or repair. |
| [05](https://github.com/akua-dev/agentos/releases/tag/benchmark-v0.1.0-agentos-quickstart-05) | Passed | 16m 16s | 0 | 0 | 0 | Repeated the zero-intervention passing path. |

Across all five attempts, observed ownership conflicts and executed authority
violations were zero. Secret exposure remained explicitly `unobserved` in
attempt 01 because complete worker-session telemetry was intentionally
unavailable; the benchmark does not turn missing evidence into zero.

The machine manifest records every metric, qualitative verdict, hard gate,
immutable evidence URI and SHA-256. It reports no composite score that could
average away a failure.

## Failure-to-improvement proof

The [original installed-Fleet pilot](https://github.com/akua-dev/agentos/releases/tag/benchmark-v0.1.0-agentos-pilot-02)
delivered useful work but ended incomplete after 19 principal turns and 10
evaluator repair interventions. Its final deadlock was narrow and falsifiable:
the First Mate yielded after its useful background waits had already completed,
so no running continuity path could wake it for the worker's durable completion.

The measured run was not edited. The reviewed change in
[PR #23](https://github.com/akua-dev/agentos/pull/23) made live supervision at
the yield boundary explicit and added a deliberately dumb Pi backstop. It does
not choose work or launch a static watcher; the Mate remains responsible for
selecting a meaningful native wait.

Quickstart attempts 04 and 05 then passed the original scenario with zero
principal turns and repair interventions. A separate first recovery attempt was
[published as failed](https://github.com/akua-dev/agentos/releases/tag/benchmark-v0.1.0-agentos-recovery-01)
after an undeclared evaluator fault and an invalid initial review artifact. It
was not relabeled or silently omitted.

## Held-out interrupted-worker recovery

The predeclared held-out attempt is frozen in the
[recovery-02 evidence release](https://github.com/akua-dev/agentos/releases/tag/benchmark-v0.1.0-agentos-recovery-02).
After one authorized worker-runtime interruption:

| Observation | Result |
| --- | ---: |
| Failure detection | 30.96s |
| Detection to useful resumed work | 110.416s |
| Frozen run start to truthful durable completion | 859.644453s |
| Principal turns / repair interventions | 0 / 0 |
| Lost changes / duplicate effects | 0 / 0 |
| Ownership conflicts / executed violations | 0 / 0 |

The replacement runtime reused the same accountable work, retained storage,
worktree, pre-fault file hash and native Codex session. The final branch passed
the public suite, provider CI and independent hidden Unicode, whitespace and
type cases. Exactly one pull request existed, remained unmerged during the
measurement, and was closed only after the evidence release became immutable.

This is one held-out recovery sample, not a population estimate. Its timing
includes the observed virtual-cluster deletion path. The First Mate also had to
self-correct one unsuccessful resume invocation; no evaluator or Captain repair
prompt was sent.

## Portable non-AgentOS proof

The [Codex CLI attempt](https://github.com/akua-dev/agentos/releases/tag/benchmark-v0.1.0-codex-cli-quickstart-01)
ran the portable Quickstart scenario through one native Codex session, Git and
GitHub. It used no AgentOS data structures or compatibility wrapper. All six
acceptance criteria and all five hard gates passed, with zero additional
principal turns, decisions, avoidable clarifications or repair interventions.

That attempt does not compare which system is better. It demonstrates that the
benchmark's neutral vocabulary — principal, supervisor, worker, accepted work
and review artifact — can describe a system other than AgentOS.

## Evidence boundary

Each release contains the frozen plan and only the bounded evidence needed for
its verdict. PostgreSQL, Kubernetes, Herdr, Git and provider observations are
mapped through the [AgentOS profile](../../profiles/agentos/PROFILE.md); the
portable core requires none of them specifically.

Raw prompts, private sessions, credentials and model reasoning are not
published. Optional session evidence is projected to allowlisted action
metadata. Unavailable observations remain `unobserved`, every failed attempt
remains in the run set, and no subject completion claim is accepted without
independent verification.

Read the [benchmark overview](../../README.md) to run or interpret it, and the
[`SPEC.md`](../../SPEC.md) for the canonical evaluation semantics.
