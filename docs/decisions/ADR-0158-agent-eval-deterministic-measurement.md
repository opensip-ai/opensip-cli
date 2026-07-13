---
status: active
last_verified: 2026-07-12
owner: opensip-cli
---

# ADR-0158: Use Deterministic Two-Arm Agent Evaluation

```yaml
id: ADR-0158
title: Use deterministic two-arm agent evaluation
date: 2026-07-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0095, ADR-0157]
tags: [evaluation, determinism, persistence, mcp]
enforcement: not-mechanizable
enforcement-reason: >
  Control-first authoring, symmetric discoverability, and the realism of a
  scripted strategy are review judgments rather than static repository facts.
  Derived shape invariants are already executable in the package's registry,
  scorer, report-validator, and determinism tests. A repository fitness check
  would have to interpret harness-internal task data and would invert
  ADR-0157's black-box boundary.
```

**Decision:** Evaluate agent-facing context with deterministic, two-arm gold
tasks. Author the native search/read/glob control strategy first, then run both
it and the OpenSIP CLI/MCP strategy under the same symmetric-discoverability
rule and early-exit contract. Make cumulative UTF-8 response bytes the headline
cross-arm cost; report call count as approximate turns and wall time as a
diagnostic. Do not call models or the network.

Freeze tasks, fixtures, assertions, and ground truth. Version strategies so a
public MCP surface epoch can change without rewriting what success means. Store
each measurement as an immutable, gitignored, self-identifying file-plane
`EvalReport`: `results/<utc>-v<cliVersion>-<gitSha>.json` plus a sibling
Markdown summary. The report has an integer `schemaVersion` plus a required
SHA-256 `contractFingerprint` over selected task truth and committed fixture
bytes. Versioned strategies are excluded from that digest and remain explicit
on each arm. The schema evolves through additive optional fields after its
required v1 contract; it is never persisted as a datastore session, `tool_state`
row, or baseline fingerprint.

Capture an atomic Git revision/worktree snapshot at run start and recheck it
immediately before artifact persistence. Reports from a dirty worktree or a
revision that changed during execution are labeled non-promotable in JSON and
Markdown and use a `-dirty` default filename suffix. Only a report whose
`sourceState` is `clean` is promotion evidence.

Resolve the initial Git snapshot before computing the contract fingerprint, so
the closing snapshot invalidates any commit or worktree change that overlaps
fixture hashing. Promotion comparisons require both reports to have matching
selected task ids and the same contract fingerprint; a mismatch starts a new
baseline rather than being interpreted as product improvement.

**Alternatives:**

- **Ingest transcripts from real agent sessions.** Deferred because model,
  prompt, and environment variance prevents deterministic replay and makes the
  first promotion gate unsuitable for CI.
- **Combine scripted tasks with transcript scoring immediately.** Rejected
  because it doubles the measurement plane before a stable deterministic
  baseline exists.
- **Use an LLM judge.** Rejected because it introduces nondeterminism and model
  execution into the open-source guardrail layer, contrary to ADR-0095.
- **Persist evaluations through the host session or baseline plane.** Rejected
  because the harness is not a Tool, emits no fingerprinted SignalEnvelope, and
  must remain independent of the persistence surface it may evaluate.

**Rationale:** A promotion gate needs repeatable before/after evidence. Typed
strategies and response-derived fact bindings expose exactly which calls and
bytes were necessary, while completeness, freshness, truncation, and negative
proof remain first-class trust states. Negative proof requires an exhaustive
same-leg transport prefix, lossless response projections, and an explicit
semantic-domain-exhausted attestation on the proof-bearing response. The additive
optional `proofRelevance` and `proofClosure` diagnostics preserve that distinction
without breaking schema v1. Projection relevance is the default, so a missing
closure attestation fails closed; only independent setup/state steps explicitly
opt out. A terminal query over a partial, unresolved, lossy, or still-open derived
frontier cannot certify absence. Proof assessors share the extractor's exact
projection boundary: malformed manifest bytes, omitted graph fields, ambiguous
native occurrences, and any node at a bounded traversal depth keep the domain
open. A frozen answer contract prevents a new
capability from winning by narrowing the question or synthesizing knowledge
that did not appear in a response. The digest makes that frozen-contract claim
auditable across revisions without conflating legitimate strategy-version
changes with task or fixture drift.

The digest and disposable fixture copy share one bounded Git-visible regular-
file inventory. Ignored artifacts are excluded from both planes, preventing an
unhashed environment/build/log file from influencing a promotion-eligible run.
Dogfood native tools use the same Git-visible view. Because its OpenSIP arm reuses
a persisted repository catalog, provenance also inspects ignored language source,
package/build manifests, and graph configuration outside known graph exclusions;
any match makes the report non-promotable.

File artifacts are the smallest honest persistence plane. Their filename and
header bind the CLI version, harness version, Git revision, platform, Node
version, and run time without coupling the harness to SQLite schema or host
session lifecycle. Exclusive writes preserve old baselines, and a JSON/Markdown
pair serves both agents and human reviewers. A Git SHA fully identifies the
measured source only for a clean worktree, so dirty calibration runs disclose
that limitation rather than inheriting the clean self-identifying claim.

**Consequences:**

- Before-baseline failures are data, not process failures. In particular,
  impact, test-selection, and staleness scenarios may expose current product
  gaps while the harness exits successfully and preserves the evidence.
- Promotion reviews compare correctness and incorrect-`none` outcomes before
  cost. Setup and recovery calls remain separate from primary retrieval metrics.
- A strategy epoch change updates `strategyVersion`; a report contract break
  increments `schemaVersion`. Existing artifacts are immutable and are not
  migrated or re-read by the product.
- Before/after promotion artifacts must agree on selected tasks and
  `contractFingerprint`; otherwise reviewers establish a new baseline after
  examining the task/fixture source diff.
- Reports preserve canonical-root verification and stderr size/truncation
  metadata, not absolute project roots or raw stderr content.
- Dirty or mid-run-changed reports remain available for implementation and
  calibration, but their required provenance state makes them ineligible for a
  promotion comparison.
- Manual runs with real coding agents remain a calibration aid, not part of the
  deterministic score or a substitute for the two-arm report.

**Related specs / ADRs:** [ADR-0095](ADR-0095-ai-native-guardrail-platform-posture.md)
sets the no-model boundary, and
[ADR-0157](ADR-0157-agent-eval-black-box-harness.md) defines where the
instrument runs. The operational protocol is in
[`packages/agent-eval/README.md`](../../packages/agent-eval/README.md).
