/**
 * `@opensip-cli/tool-trivy` Tool descriptor (ADR-0090 / ADR-0091 / ADR-0092).
 *
 * The third External Tool Adapter — and the FIRST real consumer of the substrate's
 * shared `ingestSarif`. It wraps the user-installed `trivy` vulnerability +
 * misconfiguration scanner as an ordinary opensip-cli `Tool` via {@link
 * defineExternalToolAdapter}. The substrate owns binary resolution, the run loop
 * (resolve → execFile → ingest → normalize → persist via the host artifact seam),
 * provenance, and the auto-added `doctor`/`version` commands; this module declares
 * only the trivy identity, the wrapped binary, and the `scan` command (args only).
 *
 * Unlike gitleaks/osv-scanner (JSON adapters with a per-adapter `parse`), Trivy is
 * the SARIF adapter: its `scan` command declares `output: { kind: 'sarif' }` and
 * OMITS `parse`. The substrate's shared `ingestSarif` reads the SARIF 2.1.0 log,
 * recovering each finding's four-bucket severity from the rule descriptor's
 * `properties["security-severity"]` (a CVSS number) BEFORE the lossy `level`
 * fallback (the OpenSIP SARIF writer collapses critical AND high → `error`, so a
 * `9.8` result with `level:"error"` must normalize to `critical`, not `high`).
 *
 * Layer 4: imports the substrate + `@opensip-cli/core` ONLY — never the CLI,
 * output, or any other adapter (dependency-cruiser enforced). The
 * `single-sarif-ingest` rule means this adapter MUST NOT parse SARIF itself; it
 * relies on the one substrate reader.
 *
 * This is an OPT-IN, installed tool (NOT in `bundled-tools.manifest.json`): the
 * host never imports this runtime; an `opensip trivy` invocation forks a worker
 * that re-discovers + imports it and runs the handler. Installed tools are
 * deny-by-default — a run needs `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` to include the
 * trivy id.
 */

import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter } from '@opensip-cli/external-tool-adapter';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

/** Human identity (`opensip trivy`). No aliases. */
export const TRIVY_IDENTITY: ToolIdentity = {
  name: 'trivy',
};

/** Stable UUID identity (ADR-0048); mirrors `opensipTools.stableId` in package.json. */
export const TRIVY_STABLE_ID = 'a26ea0eb-ee3b-4e22-a3f3-7e1f93e16000';

/**
 * Normalize the `trivy --version` stdout to a bare semver. Trivy prints a
 * multi-line banner whose first line is e.g. `Version: 0.50.1` (followed by the
 * vulnerability/Java DB metadata); take the first semver-shaped token and strip a
 * leading `v`.
 *
 * VERIFY-against-installed-binary: exact `trivy --version` output format.
 */
export function parseTrivyVersion(stdout: string): string {
  // Fully bounded ({1,5} digit runs, {1,2} dotted segments) so the matcher is
  // linear — major.minor[.patch], optional leading `v`.
  const match = /v?(\d{1,5}(?:\.\d{1,5}){1,2})/.exec(stdout);
  return match?.[1] ?? stdout.trim();
}

/**
 * Build the trivy scan argv (no shell — args are passed to `execFile`). Scans the
 * project filesystem (`fs <root>`) for vulnerabilities + misconfigurations and
 * writes a SARIF 2.1.0 report to the host-owned artifact path the substrate
 * composes for this run.
 *
 * Local-only posture (ADR-0092): Trivy fetches its vulnerability DB from GHCR on
 * first run, so the scan is pinned offline with `--skip-db-update`,
 * `--skip-java-db-update`, and `--offline-scan`. This REQUIRES a pre-populated DB
 * cache (`trivy fs` once online, or `trivy image --download-db-only`); the
 * adapter's `doctor` notes the cache caveat.
 *
 * VERIFY-against-installed-binary: the local-only flag set across versions.
 * Trivy is NOT passed `--exit-code` — it exits 0 even with findings, and the
 * substrate derives findings from the parsed SARIF (any nonzero is a fault).
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  return [
    'fs',
    '--format',
    'sarif',
    '--output',
    ctx.artifactPath('trivy.sarif'),
    '--skip-db-update',
    '--skip-java-db-update',
    '--offline-scan',
    ctx.projectRoot,
  ];
}

/**
 * A3: build trivy's exclusion of opensip's own `.runtime` artifact store. Trivy
 * takes a directory skip via `--skip-dirs`; the substrate supplies the path and
 * the run loop appends the flag (no user-facing flag, so the command manifest is
 * unchanged). VERIFY-against-installed-binary: `--skip-dirs` accepts an absolute
 * path / glob and may be passed after the positional scan root.
 */
export function buildTrivyExclude(input: { readonly excludePath: string }): {
  readonly args: readonly string[];
} {
  return { args: ['--skip-dirs', input.excludePath] };
}

/**
 * The trivy external-tool adapter `Tool`. The host loads it by name through the
 * installed-tool worker-dispatch path (the barrel re-exports it as `tool`).
 */
export const tool: Tool = defineExternalToolAdapter({
  identity: TRIVY_IDENTITY,
  metadata: {
    id: TRIVY_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Vulnerability + misconfig scanning via Trivy',
    adapterPackage: '@opensip-cli/tool-trivy',
  },
  binary: {
    command: 'trivy',
    versionArgs: ['--version'],
    versionParse: parseTrivyVersion,
    // `trivy fs --format sarif --output` is stable from 0.40. VERIFY-against-
    // installed-binary (the local-only flag names have shifted across versions).
    minVersion: '0.40.0',
    // Operator pin (config `binaries.trivy.path` / `OPENSIP_TRIVY_BIN`) beats
    // PATH; resolution never fetches a binary.
    resolution: ['config', 'path'],
    installHint:
      'Install trivy: https://aquasecurity.github.io/trivy/latest/getting-started/installation/ (brew install trivy). Pre-populate the vuln DB cache for offline scans (e.g. `trivy image --download-db-only`).',
  },
  // Trivy queries its LOCAL vuln DB cache via execFile with --offline-scan — no
  // network, no credentials at scan time (the DB cache must be pre-populated).
  network: 'local-only',
  commands: [
    {
      name: 'scan',
      description: 'Scan the project filesystem for vulnerabilities and misconfigurations (Trivy)',
      args: buildScanArgs,
      // SARIF adapter: no `parse` — the substrate's shared `ingestSarif` reads it,
      // recovering severity from `driver.rules[ruleIndex].properties["security-severity"]`.
      output: { kind: 'sarif', path: 'trivy.sarif' },
      // A3: never re-walk opensip's own persisted reports under `.runtime/` (see
      // {@link buildTrivyExclude}).
      excludeScan: buildTrivyExclude,
      // ADR-0091 Phase-0 decision 4 (Trivy): Trivy exits `0` even WITH findings (no
      // `--exit-code` passed), so findings are derived from the parsed SARIF, not the
      // exit code. Only `0` is clean; there is NO findings code; any nonzero (>= 1)
      // is a genuine fault. (Passing `--exit-code 1` would collide findings-1 with
      // error-1 — the gitleaks sharp edge — so it is deliberately omitted.)
      exitCodes: { ok: [0], findings: [], errorFrom: 1 },
    },
  ],
  // Scanner output is line-volatile → the line-shift-tolerant message hash, not the
  // host `ruleId|file|line|col` default. Stamped worker-side in the run loop.
  fingerprintStrategy: 'message-hash',
});
