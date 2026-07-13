# Agent-Eval Promotion Instrument

`@opensip-cli/agent-eval` is the promotion-gate instrument for agent-facing
context surfaces. It measures whether a deterministic OpenSIP CLI/MCP strategy
recovers the required evidence more correctly and efficiently than ordinary
content search, file reads, and globbing. It is a surface-quality proxy, not an
adoption study and not a measurement of model, prompt, or user behavior.

The run and review protocol lives in `packages/agent-eval/README.md`. Each run
writes an immutable JSON report and human-readable Markdown companion. Review
correctness and false-empty answers before response bytes, calls, or time, and
keep setup and staleness-recovery costs separate from primary retrieval cost.
Only reports with `sourceState: "clean"` and `promotionEligible: true` are valid
promotion evidence. Dirty and mid-run-changed reports are labeled
non-promotable and remain useful only for implementation and calibration.
Before/after artifacts must also carry the same `contractFingerprint`, which
binds the selected task truth and committed fixture bytes while leaving
versioned strategies independently visible on each arm.

Some current-surface failures are intentional deliverables. The impact,
test-selection, and staleness scenarios preserve before-baselines that a future
context capability must beat; making those tasks pass by weakening assertions
would erase the promotion evidence the package exists to provide.

Negative findings are promotable evidence only when transport coverage, response
projection, and semantic frontier closure all agree. Every projection-relevant
prefix step must carry an explicit closure attestation; missing attestations fail
closed, while independent setup/state steps opt out explicitly. Bounded caller
depth, an unresolved graph edge, an unprojectable native reference, or a remaining
caller-frontier fact keeps the corresponding absence assertion inconclusive. A
node at the requested traversal-depth cap is always an open frontier unless the
surface explicitly attests that it has no successors.

The local program source of truth is
`docs/plans/backlog/agent-task-context-and-codebase-intelligence.md`, and
promotion reviews belong under `docs/plans/reviews/`. Both locations are
gitignored planning space. Durable architectural posture lives in:

- [ADR-0157](../decisions/ADR-0157-agent-eval-black-box-harness.md) — the
  workspace-private black-box boundary.
- [ADR-0158](../decisions/ADR-0158-agent-eval-deterministic-measurement.md) —
  deterministic two-arm measurement and immutable report artifacts.
