/**
 * `@opensip-cli/tool-osv-scanner` Tool descriptor (ADR-0090 / ADR-0091 / ADR-0092).
 *
 * The second External Tool Adapter: it wraps the user-installed `osv-scanner`
 * dependency-vulnerability scanner as an ordinary opensip-cli `Tool` via {@link
 * defineExternalToolAdapter}. The substrate owns binary resolution, the run loop
 * (resolve → execFile → ingest → normalize → persist via the host artifact seam),
 * provenance, and the auto-added `doctor`/`version` commands; this module declares
 * only the osv-scanner identity, the wrapped binary, and the `scan` command (args
 * + JSON parser).
 *
 * Like gitleaks, this is a JSON adapter (it routes OSV-Scanner's `--format json`,
 * which is richer than its SARIF output, through a per-adapter `parse`, NOT the
 * shared `ingestSarif`).
 *
 * Layer 4: imports the substrate + `@opensip-cli/core` ONLY — never the CLI,
 * output, or any other adapter (dependency-cruiser enforced).
 *
 * This is an OPT-IN, installed tool (NOT in `bundled-tools.manifest.json`): the
 * host never imports this runtime; an `opensip osv-scanner` / `opensip osv`
 * invocation forks a worker that re-discovers + imports it and runs the handler.
 * Installed tools are deny-by-default — a run needs
 * `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` to include the osv-scanner id.
 */

import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter } from '@opensip-cli/external-tool-adapter';

import { parseOsvJson } from './parse-osv-json.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

/** Human/aliased identity (`opensip osv-scanner` / `opensip osv`). */
export const OSV_SCANNER_IDENTITY: ToolIdentity = {
  name: 'osv-scanner',
  aliases: ['osv'],
};

/** Stable UUID identity (ADR-0048); mirrors `opensipTools.stableId` in package.json. */
export const OSV_SCANNER_STABLE_ID = 'd25a4471-3289-4660-b5ab-63830072d0e1';

/**
 * Normalize the `osv-scanner --version` stdout to a bare semver. OSV-Scanner
 * prints a multi-line banner whose first line is e.g. `osv-scanner version: 1.9.1`
 * (or, on some builds, just `1.9.1`); take the first semver-shaped token and strip
 * a leading `v`.
 *
 * VERIFY-against-installed-binary: exact `osv-scanner --version` output format.
 */
export function parseOsvVersion(stdout: string): string {
  // Fully bounded ({1,5} digit runs, {1,2} dotted segments) so the matcher is
  // linear — major.minor[.patch], optional leading `v`.
  const match = /v?(\d{1,5}(?:\.\d{1,5}){1,2})/.exec(stdout);
  return match?.[1] ?? stdout.trim();
}

/**
 * Build the osv-scanner scan argv (no shell — args are passed to `execFile`).
 * Scans the project recursively (`-r <root>`) and writes a JSON report to the
 * host-owned artifact path the substrate composes for this run. OSV-Scanner ships
 * an embedded/offline advisory DB, so the scan is local-only (no network, no auth).
 *
 * VERIFY-against-installed-binary: this is the stable v1.x flat invocation
 * (`osv-scanner --format json --output <path> -r <root>`). OSV-Scanner v2.x
 * reorganized the surface to `osv-scanner scan source -r <root>`; if v2 becomes the
 * floor, switch on the doctor-detected version. (The flags `--format`, `--output`,
 * `-r` are stable across both.)
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  return ['--format', 'json', '--output', ctx.artifactPath('osv.json'), '-r', ctx.projectRoot];
}

/**
 * The osv-scanner external-tool adapter `Tool`. The host loads it by name through
 * the installed-tool worker-dispatch path (the barrel re-exports it as `tool`).
 */
export const tool: Tool = defineExternalToolAdapter({
  identity: OSV_SCANNER_IDENTITY,
  metadata: {
    id: OSV_SCANNER_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Dependency vulnerability scanning via OSV-Scanner',
    adapterPackage: '@opensip-cli/tool-osv-scanner',
  },
  binary: {
    command: 'osv-scanner',
    versionArgs: ['--version'],
    versionParse: parseOsvVersion,
    // The flat `--format json --output -r` invocation is stable from v1.4.
    // VERIFY-against-installed-binary (v2.x moved verbs under `scan source`).
    minVersion: '1.4.0',
    // Operator pin (config `binaries.osv-scanner.path` / `OPENSIP_OSV_SCANNER_BIN`)
    // beats PATH; resolution never fetches a binary.
    resolution: ['config', 'path'],
    installHint:
      'Install osv-scanner: https://google.github.io/osv-scanner/installation/ (brew install osv-scanner)',
  },
  // OSV-Scanner queries its embedded/offline advisory DB via execFile — no
  // network, no credentials.
  network: 'local-only',
  commands: [
    {
      name: 'scan',
      description: 'Scan project dependencies for known vulnerabilities (OSV-Scanner)',
      args: buildScanArgs,
      output: { kind: 'json', path: 'osv.json' },
      // ADR-0091 Phase-0 decision 4 (OSV): `0` clean, `1` findings, `>=2` fault.
      // The exception is `128` ("no packages/lockfiles found") — a genuinely CLEAN
      // no-op (a project with no dependency manifests), NOT a fault, so it joins the
      // `ok` set. With `errorFrom: 2`, `127` (general/usage error) still faults.
      // VERIFY-against-installed-binary: the exact nothing-scanned code (recollection
      // 128) across versions.
      exitCodes: { ok: [0, 128], findings: [1], errorFrom: 2 },
      parse: parseOsvJson,
    },
  ],
  // Scanner output is line-volatile → the line-shift-tolerant message hash, not the
  // host `ruleId|file|line|col` default. Stamped worker-side in the run loop.
  fingerprintStrategy: 'message-hash',
});
