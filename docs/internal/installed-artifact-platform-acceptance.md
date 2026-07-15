# Installed-Artifact Platform Acceptance

Maintainer + agent guide for the installed-artifact acceptance harness under
`scripts/platform-acceptance/`. This harness qualifies the **exact bytes a
customer installs** — not a workspace build — against a closed catalog of
customer journeys, and emits ONE independently verifiable evidence artifact.

The durable *why* (evidence authority, ownership, non-product posture) is
[ADR-0164](../decisions/ADR-0164-installed-artifact-platform-acceptance-evidence.md).
The user-facing script quick reference is the "Platform acceptance" section of
[`scripts/README.md`](../../scripts/README.md). This document is the deeper
operational contract for people (and agents) who run, diagnose, or extend it.

> **This document makes no supported-platform claim.** A passing run is evidence
> for one candidate on one host under one profile. Declaring an OS supported —
> choosing the profile, cadence, burn-in, and publication policy — is a separate,
> deliberate OS-specific plan that references ADR-0164.

## Architecture and data flow

Two independent processes, by design — the runner never grades itself:

```text
                        run-platform-acceptance.mjs
                        ─────────────────────────────
  candidate source ──▶ candidate-lifecycle ──▶ runner (stage machine) ──▶ evidence-writer
  (packed | published)   (install/upgrade/remove   │  journeys in profile     (seal + atomic
   verified + isolated)   in hermetic run root)     │  order, bounded procs)    write)
                                                     ▼
                                     platform-acceptance.v1 JSON  ──▶  uploaded artifact
                                                     │
                        verify-platform-acceptance.mjs (SEPARATE process)
                        ─────────────────────────────
                          reloads profile + evidence, re-parses the schema,
                          recomputes profileDigest / summary / verdict /
                          sealed-body digest, requires the completion record,
                          and cross-checks optional expected values ──▶ exit 0/1/2
```

Module ownership:

| File | Role |
|---|---|
| `scripts/platform-acceptance/contract.{mjs,d.mts}` | Closed profile/evidence schema, verdict functions, `composeProfile`, `canonicalize`/`digestOf`. `contract.d.mts` is the single type source. |
| `scripts/platform-acceptance/host-profile.mjs` | Bounded, secret-free native host facts + declared capability probes. |
| `scripts/platform-acceptance/candidate-source.mjs` | Resolves + verifies the two candidate forms into a `CandidateIdentity`. |
| `scripts/platform-acceptance/candidate-lifecycle.mjs` | Installs / upgrades / removes the candidate in isolated npm + home state; exposes the `installed-bin` shim and the real `bin` JS entrypoint. |
| `scripts/platform-acceptance/journey-catalog.mjs` | The ONE closed journey registry (46 ids). Lifecycle journeys defined here; the other 40 imported from `journeys/*.mjs`. |
| `scripts/platform-acceptance/journeys/{analysis,extensions,mcp,output,persistence,resilience}.mjs` | Journey executors, keyed by profile id. |
| `scripts/platform-acceptance/runner.mjs` | Stage machine over the closed stage vocabulary; produces the sealed evidence body (sans `completion`) + an exit classification. |
| `scripts/platform-acceptance/evidence-writer.mjs` | Seals + validates + atomically writes the artifact; renders bounded summaries. |
| `scripts/lib/measured-process.mjs` | The one bounded process primitive (argv, timeout, output tails, process-tree RSS + termination). Shared with `scripts/perf/`. |
| `scripts/run-platform-acceptance.mjs` | CLI entry: parses the closed grammar, runs, writes, maps outcome → exit code. |
| `scripts/verify-platform-acceptance.mjs` | Independent verifier entry. |

The stage stream is the **only** observability plane: no OTel span, no OpenSIP
log event, no `StoredSession` row, no datastore migration. Evidence is a
standalone file — never persisted through the runtime datastore or `ToolState`.

## Commands

Always invoke through the package scripts (the only supported entry points). Pass
harness args after `--`:

```bash
# Qualify freshly-packed release tarballs (built first; the harness does NOT build)
pnpm platform:acceptance -- \
  --profile .config/platform-acceptance/common-v1.json \
  --packed-release /path/to/release-tarballs \
  --expected-version 0.7.0 \
  --out "/tmp/opensip-acceptance/evidence.json" \
  --json-summary

# Qualify an exact published version, upgrading FROM a previous version
pnpm platform:acceptance -- \
  --profile .config/platform-acceptance/common-v1.json \
  --published-version 0.7.0 --previous-version 0.6.0 \
  --out "/tmp/opensip-acceptance/evidence.json"

# Independently verify the sealed artifact (a SEPARATE process — always run this)
pnpm platform:acceptance:verify -- \
  --evidence "/tmp/opensip-acceptance/evidence.json" \
  --profile .config/platform-acceptance/common-v1.json \
  --expected-version 0.7.0 --expect-platform darwin --expect-arch arm64 --json
```

Both entry points print a closed-grammar `--help` (`pnpm platform:acceptance --
--help`). `--out` must be an **absolute** path **outside** the run root.

### Candidate forms (exactly one per run)

- `--packed-release <dir> [--expected-version <semver>]` — a manifest-and-checksum
  verified **complete packed release set**. The candidate source re-verifies
  `opensip-cli-release-manifest.v1.json` + `SHA256SUMS` independently before any
  tarball is trusted (ADR-0119 artifacts; same dir `release-preflight.mjs` builds).
- `--published-version <semver> [--previous-version <semver>] [--registry <https-url>]`
  — an **exact** published version already on a registry (npmjs by default; an
  explicit HTTPS mirror only). `--previous-version` installs the older version
  first and upgrades TO the primary; without it, the primary is installed and
  reinstall-migration is proven against itself.

No arbitrary npm spec, URL, branch, `latest`, or shell fragment is ever a
candidate. Candidate identity is resolved once and carried unchanged into the
verifier.

### Exit classes

Runner (`run-platform-acceptance.mjs`):

| Exit | Meaning |
|---:|---|
| `0` | Pass — profile completed and every required journey is `pass`. |
| `1` | Completed profile with an unsatisfied required journey (`fail`/`skipped`/`unavailable`). |
| `2` | Invalid invocation / profile / candidate (bad flags, unreadable/invalid profile, invalid candidate). |
| `3` | Infrastructure fault before trustworthy evidence could complete (verdict `infrastructure-fault`). |

Verifier (`verify-platform-acceptance.mjs`):

| Exit | Meaning |
|---:|---|
| `0` | Evidence verified. |
| `1` | Evidence loaded but did not verify (digest/summary/verdict/completion or expected-value mismatch). |
| `2` | Invalid invocation, or the profile/evidence file could not be read. |

## Evidence schema (v1)

`schemaVersion: 1`. Top-level `AcceptanceEvidence` fields (see `contract.d.mts`):

- `profile` — `{ id, version, digest }` (the digest the verifier recomputes).
- `candidate` — `CandidateIdentity`: `{ kind: 'packed-release' | 'published-version',
  version, source, digest, registry? }`. `source` is a human-readable,
  credential-free description; `registry` is a host only, never credentials.
- `harnessGitSha`, `startedAt`, `completedAt`.
- `host` — `HostProfile`: `platform`, `arch`, `nodeVersion`, `nodeModuleAbi`,
  bounded facts (`osRelease`, `osVersion`, `npmVersion`, `packageManager`,
  `cpuModel`, `shell` are each `T | { status: 'unavailable', reasonCode }`),
  `filesystem`, and `capabilities` (a `{ [id]: boolean }` map of declared probes).
- `results` — ordered `JourneyResult[]`: `{ id, category, required, status,
  reasonCode, durationMs, rss, diagnostics }`.
  - `status` ∈ `pass | fail | skipped | unavailable`. **Required is satisfied
    only by `pass`.** `skipped`/`unavailable` never count as proof.
  - `rss` is a tagged measurement: `{ status: 'available', peakBytes }` or
    `{ status: 'unavailable', reasonCode }`. A bare `0`/`undefined` is never a
    measurement.
- `cleanup` — `{ status: 'clean' | 'incomplete', reasonCode, removedRoots,
  residualDescendants }`.
- `summary` — deterministic counts: `total, passed, failed, skipped, unavailable,
  requiredTotal, requiredPassed`.
- `verdict` — `pass | fail | infrastructure-fault`.
- `completion` — the terminal record `{ state: 'completed' | 'infrastructure-fault',
  evidenceDigest }`, appended only after cleanup. A verifier **rejects its absence**.

### Redaction and bounds

Everything is bounded and secret-free by construction:

- Diagnostics are bounded tails (`maxDiagnosticTailBytes`, ≤ 64 per journey,
  control-stripped) — never full output, never credentials or absolute paths.
- Per-subprocess `maxStdoutBytes` / `maxStderrBytes` caps; explicit
  `journeyTimeoutMs`; total artifact capped at `maxEvidenceBytes` (the writer
  hard-fails `evidence-too-large`; the runner also stops early with
  `evidence-bound-exhausted`).
- Summaries (console + `--json-summary`) carry **only** counts + required-failure
  ids/reasons — never child stdout/stderr, never registry URLs or paths.
- Secrets are never accepted as CLI args, copied from ambient npm config, or
  serialized. Child environments are allowlisted from a deterministic base plus
  run-owned paths.

## Cleanup model

Each run owns its isolation and its teardown:

- The candidate installs into a hermetic run root under the OS temp dir with
  run-owned `HOME`/`TMPDIR`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`TEMP`/`TMP`,
  npm cache/prefix/userconfig, project roots, and runtime state. Existing
  user/project state is neither read nor deleted.
- Cleanup runs in two passes (lifecycle state, then the runner's own
  `journeys`/`fixtures`/`candidate` roots and the run root), each `realpath`-guarded
  so a symlink can never redirect a delete outside the run root.
- A cleanup escape or residual is reported as `cleanup.status: 'incomplete'` with
  a reason code — it does not silently pass.

## Troubleshooting (keyed by stable stage + reason code)

Read the evidence artifact and the runner's stage stream — **never grep
`.runtime/logs` and never inspect raw SQLite** for an acceptance verdict; those
are not this harness's evidence plane.

Stages (closed): `preflight → candidate-resolve → install → journey → upgrade →
state-remove → package-remove → cleanup → finalize`.

Runner reason codes:

| Reason code | Stage(s) | What it means / first check |
|---|---|---|
| `profile-not-found` | preflight | `--profile` missing/unreadable → check the path. |
| `profile-invalid` | preflight | Profile failed schema validation → run it through `parseAcceptanceProfile`; check bounds are positive integers. |
| `candidate-invalid` | candidate-resolve | Candidate form/args invalid, or manifest/checksum verification failed → re-check the packed dir or published version. |
| `run-root-failed` | preflight | Temp run root could not be created (verdict `infrastructure-fault`) → check temp dir writability/space. |
| `host-collection-failed` | preflight | Host fact collection threw (`infrastructure-fault`). |
| `candidate-install-failed` / `candidate-unavailable` | install | Install threw or the installed CLI was unusable → inspect the `lifecycle.install` diagnostics. |
| `candidate-lost` | after any journey | The installed bin vanished mid-run before the removal phase (`infrastructure-fault`) → suspect external interference with the run root. |
| `root-escape` | cleanup | A cleanup target `realpath`-resolved outside the run root → treat as a hardening signal; do not re-run blindly. |
| `evidence-bound-exhausted` | any | Accumulated diagnostics hit `maxEvidenceBytes`; remaining journeys become `unavailable`. |
| `cleanup-integrity-failed` | cleanup | Residual roots remained after teardown. |
| `run-cancelled` | any | Caller aborted (`infrastructure-fault`). |
| `fixtures-unavailable` | journey (extensions) | Repository fixtures could not be packed → extension journeys are `unavailable`. |
| `executor-invalid-result` / `journey-threw` | journey | A journey returned a non-conforming outcome or threw → a bug in that journey module, reported as `unavailable`, never dropped. |
| `capability-<cap>-unavailable` | journey | The host lacks a declared native capability (`pty`/`symlink`/`permissions`) → the journey is `unavailable` (optional journeys stay non-blocking). |

Writer reason codes: `out-inside-run-root`, `out-is-symlink`, `out-invalid`
(non-absolute/control chars), `evidence-too-large`, `evidence-invalid`
(sealed artifact failed re-validation), `write-failed`. Fix the `--out` path or
the bound and re-run; a write fault means no trustworthy artifact was produced.

## Extending to a new operating system

A new OS profile **composes over `common-v1`** through `composeProfile` — it does
not copy or fork the catalog:

- Bind the base by id **and digest** (`base: { id, digest }`). A base-digest
  mismatch is rejected, so a silently changed base can never be inherited.
- Composition is **additive only**: you may add journeys, add
  `requiredCapabilities`, strengthen an optional journey to required, and
  **tighten** bounds. You may NOT remove or override a base journey, weaken a
  bound, or downgrade required→optional. Composition is one-level and acyclic
  (unknown/cyclic base ids are rejected).
- Which fields may vary per OS: added journey selections, capability
  requirements, `rssRequired`, and *tighter* numeric bounds. The base journey set
  and its required floor are fixed.
- **Downgrading required coverage on the base is an ADR-reviewed change**, not a
  profile edit — required coverage is the support floor every OS inherits.
- New journeys go in the closed registry (`journey-catalog.mjs` + a `journeys/*`
  module) keyed by id; **profile data can never inject argv, env keys, or code.**
  The `platform-acceptance-journeys.test.mjs` registry/order/closure + packed-smoke
  parity checks and `platform-acceptance-contract.test.mjs` guard the contract.

## Reading the artifact + verifying (human and AI)

**Console success alone is NOT authoritative.** A green runner exit is a claim;
the sealed artifact re-checked by the independent verifier is the proof. Any
release or OS workflow MUST run the verifier as a distinct step.

Human, at a glance:

```bash
# Verdict + required coverage without trusting the runner's own console
jq '{verdict, required: "\(.summary.requiredPassed)/\(.summary.requiredTotal)",
     failed: [.results[] | select(.required and .status != "pass")
              | {id, status, reasonCode}]}' \
  "/tmp/opensip-acceptance/evidence.json"

# Then confirm the file itself verifies (the authoritative check)
pnpm platform:acceptance:verify -- \
  --evidence "/tmp/opensip-acceptance/evidence.json" \
  --profile .config/platform-acceptance/common-v1.json \
  --expected-version 0.7.0
echo "verifier exit=$?"   # 0 = verified; anything else = do NOT treat as passed
```

AI/agent, machine-readable gate:

```bash
# Parse the verifier's own JSON result; never infer a pass from the runner console.
pnpm platform:acceptance:verify -- \
  --evidence "$EVIDENCE" --profile "$PROFILE" \
  --expected-candidate-digest "$EXPECTED_DIGEST" \
  --expect-platform darwin --expect-arch arm64 --expect-node-abi 137 --json
```

The verifier reloads the profile independently, re-parses the evidence schema,
recomputes the profile digest / summary / verdict / sealed-body digest and
cross-checks each against the artifact, requires the terminal completion record,
and applies any optional expected-value cross-checks. It never echoes diagnostic
tails, registry URLs, or absolute paths. A passing verifier result on a
`common-v1` run qualifies the tested bytes on the tested host **only** — it is
evidence, not a declaration of official platform support.
