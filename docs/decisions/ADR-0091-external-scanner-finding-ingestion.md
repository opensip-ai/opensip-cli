---
status: active
last_verified: 2026-06-28
owner: opensip-cli
---

# ADR-0091: external scanner ingestion, host artifacts, and exit modeling

```yaml
id: ADR-0091
title: external scanner ingestion, host artifacts, and exit modeling
date: 2026-06-28
status: active
supersedes: []
superseded_by: null
related: [ADR-0080, ADR-0036, ADR-0042, ADR-0011]
tags: [tools, adapters, scanners, sarif, artifacts, security, persistence]
enforcement: mechanizable
enforcement-reason: >
  A single SARIF read path is enforced by the NEW `single-sarif-ingest`
  dependency-cruiser rule (no SARIF parse symbol may be imported/defined outside
  `packages/external-tool-adapter/`). Raw `.runtime` artifact writes from adapter
  code are forbidden by the existing `no-raw-fs-artifact-write-in-tool-engine`
  self-check (now governing the adapter packages). The secret-hygiene and `0600`
  guarantees are enforced by tests: the NEW negative secret-egress E2E test
  (asserts no `Secret`/`Match` substring in the worker→host `deliverSignals`
  payload) and the `0600`-perms acceptance test. See the Fitness check section.
```

**Decision:** External-scanner output is normalized to the platform's `Signal`
currency (ADR-0011) by **substrate-local** ingesters: one shared `ingestSarif`
(SARIF input types defined in `packages/external-tool-adapter/src/ingest-sarif.ts`)
plus a per-adapter JSON `parse`. `ingestSarif` recovers severity from
`driver.rules[ruleIndex].properties["security-severity"]` (CVSS bands), **not from
`level` alone**, because the OpenSIP SARIF writer collapses `critical` **and**
`high` → `error`. Each scanner's **native** severity is preserved on
`Signal.metadata` alongside the mapped four-bucket OpenSIP severity. The
`message-hash` fingerprint default is **stamped worker-side** (the host ratchet
only reads `signal.fingerprint`). A `ScannerExitModel` separates "findings" from
"fault" per scanner. Raw scanner reports are written through the **shipped
`cli.writeArtifact` seam** (ADR-0080 — **no second seam**) into a host-owned,
gitignored, `0600` per-tool artifact store with host-side retention; the matched
secret is **never** placed in `Signal.message` or any egress payload.

**Alternatives:**

- **Reuse the SARIF shape types co-located with `signal-sarif.ts`** (the spec's
  §4.7 instruction) — infeasible and rejected. Those types
  (`SarifLog`/`SarifRun`/`SarifResult`/…) are file-private/non-exported in
  `packages/output` (a layer-3 peer the substrate's depcruise rule forbids
  importing), and they are deliberately *minimal* ("only fields this emitter
  populates"). A foreign-scanner ingest must defensively read `fingerprints`,
  `properties`, multiple `runs`/`locations`, `ruleIndex`, `helpUri`, and
  `properties["security-severity"]`. The substrate defines its own **input** types;
  the output side (`Signal`/`SignalSeverity`) lives in `core`, which it may import.
- **A level-only SARIF→severity inverse** — rejected; ambiguous. The writer maps
  both `critical` and `high` to `error`, so a level-only inverse cannot recover
  `critical`. `ingestSarif` reads the CVSS `security-severity` number and applies
  FIRST/NVD v3 bands (≥9.0 critical · 7.0–8.9 high · 4.0–6.9 medium · 0.1–3.9 low),
  falling back to `error→high` (never critical) only when the number is absent.
- **Promote SARIF types to `contracts`** — rejected as gold-plating; it violates
  rule-of-three (the write side is intentionally minimal, the read side is
  substrate-local). A devDep round-trip golden (`ingestSarif(buildOpenSipSarif(…))`
  is identity on common fields) binds `@opensip-cli/output` as a **test-only**
  dependency; depcruise excludes test files, so production output imports stay
  forbidden. Precedent: `packages/graph/engine` lists `output` as a devDep for the
  same golden.
- **Read `signal.fingerprint` off the synthetic `Tool`'s `fingerprintStrategy`** —
  rejected; `synthesizeExternalTool` **drops** `fingerprintStrategy` (it carries
  only identity/metadata/command-shells/config-schema). The substrate stamps the
  `message-hash` fingerprint **inside the worker handler** when it builds the
  `SignalEnvelope`, so the host `saveBaseline`/`compareBaseline` seams just read
  `signal.fingerprint` and never re-fingerprint.
- **Treat every nonzero scanner exit as a fault** (the naive `errorFrom: 2`) —
  rejected; it misclassifies findings as failures. Scanners overload exit codes
  (gitleaks exits `1` for both leaks **and** internal `log.Fatal`), so the model is
  per-scanner and gitleaks disambiguates by **artifact presence + JSON
  parseability**.
- **A second host seam for scanner artifacts / write artifacts from the substrate
  with raw `fs`** — rejected; ADR-0080 makes durable artifact writes a host plane,
  and the `no-raw-fs-artifact-write-in-tool-engine` self-check forbids tool-side
  `.runtime` writes. The substrate composes the run-segment path and persists via
  the existing `cli.writeArtifact`.

**Rationale:** the platform already owns the destination shape (`Signal`,
ADR-0011), the ratchet that consumes fingerprints (ADR-0036), the opaque
`metadata` bag for tool-specific facts (ADR-0042), and the host artifact-write
seam (ADR-0080). Grounding against 0.1.14 surfaced three premises the spec treated
as already-true but which are **net-new host work**: (1) `atomic-artifact-write.ts`
writes with the default mode — **no `0600`**; (2) there is **no retention/pruning**
anywhere in `bootstrap/`; (3) `ProjectPaths` has **no `artifactsDir`/`artifactDir`**.
A secret scanner that writes world-readable raw reports containing live credentials,
unbounded, would be a confidentiality regression — so these are decided here, not
deferred.

**Consequences:**

- **`ProjectPaths` gains** `artifactsDir` (`<project>/opensip-cli/.runtime/artifacts`)
  and `artifactDir(tool)` (`…/artifacts/<tool>`), resolved in `resolveProjectPaths`.
  The substrate's pure `resolveScannerArtifactPath(ctx, tool, name)` composes
  `<artifactDir(tool)>/<runId>/<name>` — the **run segment is substrate-side**, and
  host-side `pruneArtifactRetention` treats the immediate children of
  `artifactDir(tool)` as the per-run dirs (no 3-arg `ProjectPaths` method needed).
- **`0600` is fixed in the host writer** (`atomic-artifact-write.ts`: `mode: 0o600`
  on `openSync` + a `chmodSync` fallback on the rename target) — the single correct
  place, covering every artifact (scanner reports, SARIF, baselines, graph catalog).
  Doing it in the substrate would be a layer violation.
- **Host-side retention:** new `packages/cli/src/bootstrap/artifact-retention.ts`
  with `pruneArtifactRetention(tool, artifactsDir, keep)`; a new `cli.artifacts.keep`
  config field (default **10**) in `cliConfigSchema`; `createWriteArtifactSeam` is
  changed to `(log, { retentionKeep })` and populated from loaded `CliDefaults`.
  After a successful write the seam prunes **only** when the target
  `isPathInside(artifactsDir)` — generic non-`.runtime` writes skip pruning
  naturally.
- **No-project fallback:** `doctor`/`version` run without a project (they only probe
  the binary); `scan` **requires** a project — `ctx.scope.projectContext === undefined`
  throws `ConfigurationError` (exit 2), mirroring MCP's datastore-unavailable
  handling.
- **`ScannerExitModel` (frozen per scanner):** gitleaks `{ ok:[0], findings:[1],
  errorFrom:2 }` plus an `artifactValid` disambiguation (exit 1 + valid JSON ⇒
  findings; exit 1 + missing/garbage ⇒ fault); OSV-Scanner `{ ok:[0], findings:[1],
  errorFrom:2 }` with "no packages/lockfiles found" ⇒ clean no-op; Trivy `{ ok:[0],
  findings:[], errorFrom:1 }` — do **not** pass `--exit-code`, let it exit 0, derive
  findings from parsed SARIF, treat any nonzero as fault.
- **Secret hygiene (guarantee):** raw scanner reports persist `0600` in the
  gitignored `.runtime/artifacts/<tool>/<runId>/` and are **never egressed**. The
  secret-scanner parsers (gitleaks) **redact** the matched secret — gitleaks
  `Secret` and `Match` are dropped to a `secretPreview`/fingerprint and never reach
  `Signal.message` or the `deliverSignals` payload. A Phase-6 negative E2E test
  asserts no `Secret`/`Match` substring crosses the worker→host RPC.
- **Native severity preserved:** `metadata.nativeSeverity` carries the raw label
  (Trivy `CRITICAL…`, OSV `MODERATE`/numeric/unknown, gitleaks `null`) beside the
  mapped four-bucket `Signal.severity`. SARIF `level` is always treated as lossy.

**Fitness check:** every structural invariant this ADR introduces is paired with
its enforcement:

| Invariant | Evaluation | Enforcement |
|-----------|-----------|-------------|
| Exactly one SARIF ingest path — no SARIF re-parse outside the substrate | **Check warranted** | NEW `single-sarif-ingest` dependency-cruiser rule (`.config/dependency-cruiser.cjs`): no SARIF read/parse symbol may be imported or defined outside `packages/external-tool-adapter/`. References this ADR in the rule comment. |
| Adapter code never writes raw `.runtime` artifacts — durable writes route through `cli.writeArtifact` | **No new check** | Existing `no-raw-fs-artifact-write-in-tool-engine` self-check (`opensip-cli/fit/checks/no-raw-fs-artifact-write-in-tool-engine.mjs`), extended to govern the adapter packages (ADR-0080 extension). |
| No matched secret (`Secret`/`Match`) reaches `Signal.message` or the `deliverSignals` egress payload | **Check warranted** | NEW negative secret-egress E2E test over a real forked worker (model: `external-tool-dispatch.test.ts` + `makeDispatchHostCtx`) — asserts no secret substring in `cap.delivered`. A source-pattern check cannot prove a runtime payload; a test can. |
| Raw scanner artifacts are written `0600` | **Check warranted** | NEW `0600`-perms acceptance test (asserts the persisted artifact mode); the host-writer `mode: 0o600` + `chmodSync` fix in `atomic-artifact-write.ts` is the single enforcement point. |
| The `message-hash` fingerprint is stamped worker-side; the host ratchet only reads `signal.fingerprint` | **No new check** | Compile-time (`synthesizeExternalTool` drops `fingerprintStrategy`) + the existing `saveBaseline`/`compareBaseline` dispatch tests proving the stamped fingerprint crosses the boundary; ADR-0036 plane never re-fingerprints. |
| Native severity preserved on `metadata`; mapped four-bucket severity on `Signal.severity`; CVSS bands drive SARIF severity | **No check warranted** | Golden unit tests per scanner (normalized-signal goldens + the `ingestSarif` round-trip golden against `buildOpenSipSarif`). A structural check cannot assert value correctness. |

**Related specs / ADRs:** implemented by `docs/plans/ready/04-external-tool-adapters/`.
Related: [ADR-0080](ADR-0080-host-owned-artifact-write-seam.md) (the host artifact
seam this extends — no second seam), [ADR-0036](ADR-0036-host-owned-baseline-ratchet-plane.md)
(the host ratchet that reads the worker-stamped fingerprint),
[ADR-0042](ADR-0042-tool-storage-contract-and-state-store.md) (the opaque
`metadata` bag carrying native severity/provenance), and
[ADR-0011](ADR-0011-signal-output-currency-formatter-sink.md) (the `Signal`
currency every parser normalizes to). The substrate/contract is
[ADR-0090](ADR-0090-external-tool-adapter-substrate.md); network/auth + the
no-egress confidentiality rule are
[ADR-0092](ADR-0092-external-adapter-network-auth-trust.md).
</content>
