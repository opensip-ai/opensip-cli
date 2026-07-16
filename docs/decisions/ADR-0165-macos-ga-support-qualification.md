---
status: active
last_verified: 2026-07-15
owner: opensip-cli
---

# ADR-0165: Qualify a narrow macOS general-availability support tuple with staged-before-promotion evidence

```yaml
id: ADR-0165
title: Qualify a narrow macOS general-availability support tuple with staged-before-promotion evidence
date: 2026-07-15
status: active
supersedes: []
superseded_by: null
related: [ADR-0017, ADR-0121, ADR-0157, ADR-0158, ADR-0164]
tags: [release, acceptance, platform, macos, support, evidence]
enforcement: mechanizable
enforced-by: ['script:macos-qualification-workflow.test.mjs', 'script:verify-supply-chain.mjs', 'script:verify-platform-acceptance.mjs', 'script:build-supported-platforms-doc.test.mjs', 'script:platform-acceptance-contract.test.mjs', 'type-structural']
enforcement-reason: >
  The macOS support decision splits into a STATIC half (tuple/overlap/status in
  the pure core registry, profile closure + support-row binding in the contract
  and verifier, stage-before-promote/least-privilege/pins in the workflow-topology
  and supply-chain tests, generated-doc/catalog single-source parity in the
  support-doc generator test) and a DYNAMIC half (installer/PTY/APFS/native-SQLite/
  signal behavior on a real Mac). The static half is mechanically enforced by the
  named Node/script tests + the type-structural `match: 'partial' | 'none'`
  projection; the dynamic half is enforced by the pinned macOS workflows running
  the independent `verify-platform-acceptance.mjs`. No new fitness check is added
  (Task 7.3): a static analysis pass cannot observe a native host completing a
  journey, so a fitness check for runtime APFS/PTY/SQLite/signal behavior would
  create false confidence. See "Mechanical enforcement" below.
```

**Decision:** OpenSIP CLI publishes its first narrow, evidence-backed macOS
general-availability support claim as ONE exact host tuple, gated by verifiable
installed-candidate evidence, and never inferred from package-engine
compatibility. The claim launches as `preview` and is promoted to `supported`
only by an external burn-in gate. It builds directly on the reusable
installed-artifact evidence contract ([ADR-0164](ADR-0164-installed-artifact-platform-acceptance-evidence.md))
and the named compatibility-contract classes ([ADR-0121](ADR-0121-platform-compatibility-lts-policy.md)),
adding the macOS-specific profile, cadence, burn-in, and publication policy.

**The exact supported tuple** (spec §4): macOS 26.x · Darwin 25.x · Apple-silicon
`arm64` · Node 24.x (module ABI `137`) · npm 11.x · APFS, case-insensitive ·
installed through the exact npm version or the canonical `scripts/install.sh`
(`OPENSIP_CLI_VERSION=<exact>`) into an isolated prefix · exercised under Apple
`/bin/zsh` with the POSIX `/bin/sh` installer · on the pinned GitHub-hosted
`macos-26` ARM64 image. `runs-on: macos-26` alone is never evidence — a fail-closed
runtime tuple preflight plus the independent verifier establish the facts.

**Everything else is explicitly out of the claim.** The exact macOS 26.x ·
Intel/x64 · Node 24.x (ABI 137) · npm 11.x · case-insensitive APFS tuple is
`unsupported` (an intentional exclusion row — no evidence for that complete
tuple). Other Intel tuples, macOS 14/15, a Node major other than 24, an npm major
other than 11, case-sensitive/HFS+/network filesystems, and non-canonical install
channels (Homebrew, pnpm/Yarn/Bun global, from-source) are `unqualified` — they
may work, but carry no evidence-backed promise, and the CLI never claims they
"cannot run". A process-only host projection cannot establish the full Intel
exclusion tuple and therefore remains `unqualified`. Linux and Windows belong to
later OS profiles and are not classified by this matrix. **`engines.node: ">=24"`
is an install/runtime floor, not a support qualification** — passing it is
necessary, not sufficient, for a supported host.

**Two native lanes, one ordering.** A **daily/main burn-in lane** builds and packs
a complete release set at a git SHA, installs those packed bytes into an isolated
consumer, runs the macOS profile, independently verifies the evidence, and retains
it. A **release lane** stages every package under an exact immutable version to a
staging dist-tag, installs that exact version on the pinned Mac, exercises the
canonical installer and the upgrade from the prior promoted exact version, and
independently verifies the sealed evidence. The normative sequence is:

```text
Ubuntu correctness/build/pack/verify
  -> npm staging publish (exact immutable version)
  -> macOS installed exact-version qualification
  -> evidence verification
  -> npm latest promotion
  -> latest-surface verification + GitHub Release
```

Verified exact-version macOS evidence is therefore a HARD dependency between npm
staging publish and `latest` promotion. `latest` is never candidate identity
during qualification; the prior `latest` exact version is captured before staging
and used only as the upgrade source. **Accepted tradeoff:** a failed macOS gate may
consume (burn) an immutable staged version, but it must never advance `latest`.
The corrective release ships under a NEW version — npm artifacts are never
overwritten. Burning a version is the deliberate price of protecting customers from
a `latest` that failed native qualification.

**Required-journey and skip semantics.** Every common profile journey from ADR-0164
is required in the macOS profile unless the spec explicitly marks it optional; the
macOS profile adds the native probes (sw_vers/Darwin/uname cross-check, APFS + case
behavior, POSIX installer + zsh, `/usr/bin/script` PTY, `/usr/bin/open` interception
without a GUI launch, native SQLite provenance, signal/contention behavior). A
**required `skipped` or `unavailable` is a failure**, never a pass — a missing native
utility is `unavailable` and fails qualification; the plan may replace a probe with a
more stable native mechanism but may not silently skip it. "Pass" means every required
journey is present with `status: "pass"`, candidate/host constraints match, cleanup
succeeded, and the independent verifier accepts the sealed evidence artifact.
Two explicit applicability cases are not missing proof: `macos.installer-sh` is
required only for a `published-version` candidate and is recorded as a non-required
`candidate-kind-not-applicable` skip for the scheduled packed lane;
`lifecycle.upgrade` becomes required only when the release lane supplies an exact
previous version and otherwise records `previous-candidate-not-supplied`. Both are
zero-effect rows whose status, reason, requirement flag, timing, RSS, and empty step
list are recomputed by the verifier. The packed lane therefore proves packed-consumer
installation; the published release lane still must prove the canonical installer,
and a release with a previous version still must prove the real previous-to-target
migration.
The profile also requires the harness's closed native capability set (`pty`,
`symlink`, `permissions`, `process-tree-rss`, and `process-tree-cleanup`) as a
host-level prerequisite. Here `process-tree-cleanup` means zero observed residual
descendants under the POSIX process-group plus sampled fixed-native process-table
model. It qualifies trusted release behavior, not hostile-code containment, and
does not prove the absence of a deliberate descendant that creates a new session
and reparents between samples. Process-table observation faults fail cleanup
closed. Retained matches additionally bind PID, process group, native session
token, and the one-second native start token. The observed command/ucomm is
diagnostic metadata only because it may change across exec; it is not part of
identity. An unrelated same-second replacement matching that stable tuple remains
a sampled-inventory collision limit.
The runner gates every journey before lifecycle effects when one is unavailable,
and the independent verifier rechecks those capability facts from sealed evidence.

**Evidence authority + retention.** The authoritative artifact is
`opensip-cli-macos-qualification.v1.json`, conforming to ADR-0164's evidence schema
and additionally binding the support-profile id/digest and the pinned support-row
id + contract version, so acceptance evidence can never satisfy a different public
support claim. It is a **standalone, internally self-checking file**: its unkeyed
digest detects incomplete, corrupted, or inconsistent contents but is not an
authenticity signature. Authenticity comes from the trusted workflow-run, artifact,
and release provenance that retains it. Release evidence is uploaded as a workflow
artifact and attached to the GitHub Release; scheduled evidence is a retained
workflow artifact. Console logs and OpenSIP runtime logs are diagnostic only and
cannot establish a pass. **No acceptance evidence is persisted in
`datastore.sqlite`, a Tool session, or cloud state.**

**Burn-in + support suspension.** Promotion from `preview` to `supported` requires 14
consecutive daily pinned-runner passes at the same profile contract version, zero
hidden required skips/unavailable, at least one release-candidate exact-published
pass (including prior-version upgrade + installer path), one intentional negative/tamper
verification proving the gate fails closed, and no unresolved severity-high install,
data-loss/corruption, cleanup, MCP-protocol, or agent-surface defect. A profile/runner/
Node/npm change restarts a 7-day focused burn-in for the changed dimension; a broad
tuple change requires the full 14 days. **Roles:** the release maintainer owns the gate;
CLI maintainers own failures; documentation/support owners publish status changes. No
workflow auto-edits the support matrix. **Suspension triggers:** any release-qualification
failure blocks promotion; one daily failure opens/links an investigation and marks the
evidence failed; two consecutive unexplained daily failures require the release owner to
move the row back to `preview`/`unqualified` before the next release; an install, corruption,
or unsafe-cleanup defect triggers immediate suspension and release blocking.

**One source-of-truth registry, projected everywhere.** A pure core policy registry
(`packages/core/src/lib/platform-support.ts`: `PLATFORM_SUPPORT_ROWS`,
`assessHostSupport`, `projectRuntimeHostSupport`) with NO filesystem/process/global
reads and no module-level mutable state drives the generated public
[Supported platforms](../public/70-reference/17-supported-platforms.md) reference,
the compatibility-policy validation, README/Quick Start/FAQ prerequisite language, and
an ADDITIVE, honest host-support projection in both `opensip agent-catalog --json`
and MCP `get_agent_catalog`. The CLI and MCP composition roots observe the live
process, call the same core projection, and map it through the single shared
`hostSupportFromRuntimeProjection` helper into the serializable `AgentHostSupport`
attached to `AgentCatalog.hostSupport` — so both surfaces emit a byte-identical
projection for identical facts. Because only process-observable facts (platform/arch/
Node version/ABI) are read, the local `match` is structurally `'partial' | 'none'`,
never `'exact'`; agents must distinguish the row's published `status` (e.g. `preview`)
from the local `match`. Machine output reports the measured host status and reason
codes and must distinguish `unsupported` from `unqualified`; it never claims an
unlisted tuple is technically unable to run. **Handoff note for the next catalog-parity
plan (Plan 03):** its common catalog assembler MUST accept this exact
`hostSupport?: AgentHostSupport` input with no adapter or rename and assert FULL-OBJECT
CLI/MCP equality (including `hostSupport`), not merely equal hostSupport payloads.

**Security posture.** The candidate version/package is fixed (no arbitrary npm spec,
shell fragment, or credentialed registry URL); workflows use pinned action SHAs and
least-privilege job permissions. Repository-controlled gates/build/pack/smoke run in an
unprivileged job, while the minimal OIDC/attestation stage job has no checkout,
dependency install, or repository-script execution and publishes only a strictly
validated, attempt-bound bundle with lifecycle scripts disabled. macOS qualification
requires no npm publish token and reads the staged public version; promotion credentials
exist only in the post-qualification promotion job, whose exact-SHA checkout does not
persist them; evidence excludes usernames, hostnames, home paths,
IPs, npm config/tokens, full environments, and unbounded child output; all cleanup is
ancestry-checked under the run-owned root; and registry-propagation retry is bounded and
cannot turn a version mismatch into a pass.

**Alternatives considered and rejected:**

- **`runs-on: macos-latest`.** Rejected: a floating label can silently drift the image
  off the qualified tuple, so its evidence is not reproducible. The lane pins `macos-26`
  and re-checks runtime facts.
- **Infer Intel/x64 from an Apple-silicon pass.** Rejected: native dependency, process,
  TTY, and lifecycle behavior differ; the exact listed Intel tuple is an explicit
  `unsupported` exclusion, while other Intel tuples remain `unqualified` until measured.
- **Treat the packed smoke or workspace E2E as support proof.** Rejected: the packed
  `smoke-pack` is a fast command-only subset with no host profile, lifecycle, RSS, or
  durable evidence, and workspace tests never exercise the installed bytes' native
  binding/shim/layout. Neither answers the support question (ADR-0164).
- **Promote `latest` before native testing (test post-promotion).** Rejected: an
  unrecoverable immutable `latest` would already be public before the gate ran. Testing
  the exact staged version BEFORE promotion is the whole point.
- **One-shot qualification (no burn-in / no ongoing cadence).** Rejected: a single
  favorable run is not a durable support claim. 14 consecutive daily passes + a staged
  release pass, with focused resets on dimension changes, establish and defend the claim.
- **Hand-maintained support/compatibility matrices.** Rejected: prose drifts from the
  policy the CLI/MCP catalogs classify against. The matrix is generated from the one core
  registry and a check gate fails on drift.
- **Block unqualified hosts.** Rejected: `unqualified` means "not measured", not "cannot
  run". Qualification status must not change command exit semantics for ordinary tools;
  an unqualified host is at most an informational warning, a known-`unsupported` host an
  actionable warning + link — never an install block or a non-zero exit.
- **Ship an `opensip acceptance`/`opensip support` command.** Rejected (as in ADR-0164):
  qualification is a release harness under `scripts/`, not a customer runtime surface;
  the host-support READ projection rides the existing agent-catalog/MCP surface only.
- **Persist acceptance evidence in the datastore or a Tool session.** Rejected: evidence
  is an uploaded, internally self-checking file retained with trusted workflow/release
  provenance; the datastore/session planes are for tool results, not release
  qualification.

**Observability contract:** identical to ADR-0164 — the sealed evidence (ordered
per-journey statuses, durations, tagged RSS, closed reason codes, the runner's stage
stream, and the workflow classification summary) is the observability plane. It creates
no OTel span, no OpenSIP log event, no `StoredSession` row, and no datastore migration.
Diagnosis is keyed on stable reason codes/stages and the classification, never on
grepping `.runtime/logs` or reading raw SQLite.

**Consequences:**

- The public/machine matrix flips to `supported` only after burn-in and clearly scopes
  the claim; the exact Intel exclusion stays `unsupported` and every other unmeasured
  tuple stays `unqualified`.
- `latest` promotion + the GitHub Release cannot run until exact staged-version macOS
  evidence verifies; a failed gate may burn a staged version but never advances `latest`.
- The host-support READ path is additive and behavior-neutral: no datastore migration,
  session payload, ToolState record, ToolCliContext seam, host-timing contribution, or
  config namespace is added; acceptance stays absent from root commands, the bundled
  manifest, completion, and the MCP tool inventory.
- **No new fitness check** is added (Task 7.3). Static analysis cannot observe native
  APFS/PTY/SQLite/signal behavior, so a fitness check would create false confidence; the
  workflow-topology + supply-chain + contract/verifier + generator tests cover the static
  decisions, and the pinned native workflows + independent verifier cover the dynamic ones.

**Mechanical enforcement (Task 7.3 map):** tuple/overlap/status → the pure core registry
tests + the compatibility-matrix constant-drift guard; profile closure + support-row
binding → `platform-acceptance-contract.test.mjs` and `verify-platform-acceptance.mjs`;
stage-before-promote + least privilege + action pins + `if: always()` evidence →
`macos-qualification-workflow.test.mjs` and `verify-supply-chain.mjs`; generated-doc ↔
catalog single-source parity → `build-supported-platforms-doc.test.mjs`; installed native
behavior → the pinned `macos-qualification.yml` / three-job `release.yml` running the
independent verifier. Existing dependency-cruiser already keeps core/contracts/CLI/MCP
layering honest (no Tool→CLI edge, contracts imports no core, MCP imports no CLI), so no
new architecture rule is required.

**Related specs / ADRs:** [ADR-0017](ADR-0017-release-gate-policy.md) owns release-gate
strictness and the single-source publishable set/order this qualifies;
[ADR-0121](ADR-0121-platform-compatibility-lts-policy.md) owns the compatibility-contract
classes (this adds the `platform-support` class version);
[ADR-0157](ADR-0157-agent-eval-black-box-harness.md) and
[ADR-0158](ADR-0158-agent-eval-deterministic-measurement.md) own the black-box agent-eval
posture whose installed smoke lane this targets at the installed candidate;
[ADR-0164](ADR-0164-installed-artifact-platform-acceptance-evidence.md) owns the reusable
installed-artifact evidence contract this consumes. Implementation: the spec, profile,
workflows, verifier, generator, and support reference
(`docs/plans/specs/02-macos-ga-qualification.md` and
`docs/plans/ready/02-macos-ga-qualification/` — local, gitignored;
`.config/platform-acceptance/macos-26-arm64-node24-npm11-v1.json`;
`.github/workflows/macos-qualification.yml` + the three-job `.github/workflows/release.yml`;
`scripts/verify-platform-acceptance.mjs`; `scripts/build-supported-platforms-doc.mjs`;
`docs/public/70-reference/17-supported-platforms.md`; the sealed
`opensip-cli-macos-qualification.v1.json` release evidence). The ongoing operations runbook
is kept locally under `docs/internal/` (private working context, not committed); committed
release usage lives in `RELEASING.md`.
```
