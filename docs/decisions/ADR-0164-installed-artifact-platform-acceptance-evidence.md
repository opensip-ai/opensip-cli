---
status: active
last_verified: 2026-07-15
owner: opensip-cli
---

# ADR-0164: Qualify installed-artifact platform support with independently verifiable evidence

```yaml
id: ADR-0164
title: Qualify installed-artifact platform support with independently verifiable evidence
date: 2026-07-15
status: active
supersedes: []
superseded_by: null
related: [ADR-0017, ADR-0119, ADR-0121, ADR-0150, ADR-0157, ADR-0158]
tags: [release, acceptance, evidence, platform, testing]
enforcement: mechanizable
enforced-by: ['script:platform-acceptance-contract.test.mjs', 'script:platform-acceptance-journeys.test.mjs', 'script:verify-platform-acceptance.mjs']
enforcement-reason: >
  This is dynamic native-host behavior, so no fitness check is warranted: a
  static analysis pass cannot observe an installed candidate completing a journey
  on a real host. The versioned contract validators (`parseAcceptanceProfile` /
  `parseAcceptanceEvidence` / `composeProfile`) pinned by
  platform-acceptance-contract.test.mjs, the registry/order/profile-closure and
  packed-smoke parity assertions in platform-acceptance-journeys.test.mjs, and the
  independent workflow verifier `verify-platform-acceptance.mjs` are the
  mechanical enforcement. A release/OS workflow that trusts the runner console
  without the verifier gate is the failure this ADR forbids.
```

**Decision:** Operating-system support qualification targets the **exact installed
bytes** a customer runs — never a workspace build — exercises them through a
**closed data profile** of customer journeys, and requires an independently
verifiable `platform-acceptance.v1` evidence artifact as the authority. A
candidate is one of exactly two forms: a manifest-and-checksum-verified complete
packed release set, or an exact `opensip-cli@X.Y.Z` published version; no
arbitrary npm spec, URL, branch, or shell fragment is a candidate. Each run owns
its isolation (POSIX + Windows state variables, npm cache/prefix/userconfig,
project roots, runtime state), never reads or deletes existing user/project
state, and derives the customer invocation shim (`installed-bin`) and the real
package `bin` JS entrypoint from installed metadata contained under the run root.
Every journey carries one explicit status — `pass | fail | skipped |
unavailable` — a **required** journey is satisfied only by `pass`, and the run
verdict is `pass | fail | infrastructure-fault`. Candidate and host identity are
resolved once and carried unchanged through every journey into the verifier. The
evidence is a single, atomically written, sealed file whose terminal `completion`
record is appended only after cleanup, over a recomputed sealed-body digest, so a
partial or tampered artifact can never verify. The harness owns candidate and run
cleanup. Persistence is a **standalone file only** — no datastore schema, session
row, or `ToolState` record.

**Alternatives:**

- **Trust workspace-only end-to-end tests.** Rejected: the existing acceptance
  and E2E suites exercise `packages/cli/dist`, which proves source behavior but
  never that the *installed* artifact resolves its native SQLite binding, `bin`
  shim, and package layout on a real host.
- **Treat the packed smoke as sufficient support proof.** Rejected: `smoke-pack`
  is a fast command-only subset (the `release-smoke` selection projected from the
  same catalog) with no host profile, RSS telemetry, lifecycle, or durable
  evidence contract. It catches packaging regressions; it does not answer the
  support question.
- **Qualify a `latest`/floating identity.** Rejected: `latest` is not a fixed
  tuple, so its evidence is not reproducible. A candidate must be an exact
  version or a checksum-bound packed set.
- **Install the candidate into the ambient global environment.** Rejected: it
  mutates and reads the operator's real npm prefix/cache and home state, so the
  run is neither hermetic nor safe to repeat, and cleanup cannot be authoritative.
- **Author a bespoke harness per operating system.** Rejected: N harnesses drift.
  One closed base profile (`common-v1`) plus additive, digest-bound OS composition
  keeps every OS measuring the same journeys.
- **Keep raw runner logs (or `.runtime` SQLite) as the record of a support run.**
  Rejected: logs are unbounded event streams that may not match a run's semantics.
  The versioned JSON artifact is the one authority; the console is a bounded
  summary only.
- **Ship an `opensip acceptance` command.** Rejected: qualification is a
  development/release harness under `scripts/`, not a customer runtime surface. A
  mounted command would add a publishable API, invite in-product model/mutation
  coupling (against [ADR-0095](ADR-0095-ai-native-guardrail-platform-posture.md)),
  and blur the "guardrail CLI, not AI runtime" boundary.

**Rationale:** Humans need install, upgrade, output, persistence, and cleanup
confidence in the bytes they actually run; agents need a stable machine artifact
that distinguishes *failure* from *skip* from *unavailable* so absent evidence
can never read as success. The closed profile + closed journey registry keep
profile data from injecting argv, environment keys, or code, and make the
required-coverage floor unforgeable. Sealing the artifact over a recomputed
digest with a terminal completion record makes the verifier — not the runner's
own exit code — the source of truth, which is what lets an OS plan or a release
workflow gate on evidence produced by a process it does not control. RSS is a
tagged measurement (`available { peakBytes }` or `unavailable { reasonCode }`) so
a `0`/`undefined` never masquerades as proof. See
`scripts/platform-acceptance/contract.d.mts` (schema + verdict functions),
`scripts/platform-acceptance/runner.mjs` (closed stage + reason-code vocabulary),
`scripts/platform-acceptance/evidence-writer.mjs` (atomic seal), and
`.config/platform-acceptance/common-v1.json` (46 journeys).

A passing artifact is evidence for the **measured tuple only** — this candidate,
this host, this profile — and is explicitly **not** a support declaration. This
plan makes no macOS, Linux, or Windows support claim. Selecting a profile,
cadence, burn-in, and publication policy that turns evidence into a published
supported platform belongs to each OS-specific qualification plan, which
references this ADR rather than redefining evidence semantics.

**Observability contract:** the standalone evidence — its ordered per-journey
statuses, durations, tagged RSS, closed reason codes, and the runner's closed
stage stream — **is** the observability plane for this harness. It creates no
OTel span, no OpenSIP log event, no `StoredSession` row, and no datastore
migration. Diagnosis is keyed on the stable reason codes and stages, never on
grepping `.runtime/logs` or reading raw SQLite.

**Consequences:**

- OS support ADRs/plans consume this contract: they bind `common-v1` by digest,
  add or strengthen journeys additively, and may not remove a base journey,
  weaken a bound, or downgrade required coverage without an ADR-reviewed change to
  the base itself.
- No new fitness check is added for native behavior; the contract validators,
  parity tests, and the workflow verifier are the enforceable guardrails, and a
  release/OS workflow must run the verifier — a green runner console is not
  authoritative.
- The harness is not mounted as an `opensip` command and is not a publishable
  package API; it stays under `scripts/` and the private agent-eval
  installed-entrypoint seam.
- Acceptance evidence never enters the OpenSIP runtime datastore; it is an
  uploaded, self-verifying file.

**Related specs / ADRs:**
[ADR-0017](ADR-0017-release-gate-policy.md) owns the release-gate strictness and
the single-source publishable-package set/order this harness installs;
[ADR-0119](ADR-0119-verifiable-self-distribution.md) owns the release
manifest / `SHA256SUMS` / SBOM the packed-candidate source re-verifies before
trusting a tarball; [ADR-0150](ADR-0150-production-builds-publish-runtime-artifacts-only.md)
fixes the "exact installed bytes" the candidate qualifies;
[ADR-0121](ADR-0121-platform-compatibility-lts-policy.md) owns the named
compatibility contract classes an OS support decision layers on;
[ADR-0157](ADR-0157-agent-eval-black-box-harness.md) and
[ADR-0158](ADR-0158-agent-eval-deterministic-measurement.md) own the black-box,
zero-workspace-import agent-eval posture whose installed smoke lane this plan
targets at the installed candidate. Implementation:
`docs/plans/ready/01-installed-artifact-platform-acceptance/` (local, gitignored);
maintainer guide: `docs/internal/installed-artifact-platform-acceptance.md`. The
macOS qualification plan is the first downstream consumer and selects a profile,
cadence, and publication policy on top of this evidence.
