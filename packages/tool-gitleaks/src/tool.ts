/**
 * `@opensip-cli/tool-gitleaks` Tool descriptor (ADR-0090 / ADR-0091 / ADR-0092).
 *
 * The FIRST External Tool Adapter: it wraps the user-installed `gitleaks` secret
 * scanner as an ordinary opensip-cli `Tool` via {@link defineExternalToolAdapter}.
 * The substrate owns binary resolution, the run loop (resolve → execFile → ingest
 * → normalize → persist via the host artifact seam), secret redaction, provenance,
 * and the auto-added `doctor`/`version` commands; this module declares only the
 * gitleaks identity, the wrapped binary, and the `scan` command (args + JSON
 * parser).
 *
 * Layer 4: imports the substrate + `@opensip-cli/core` ONLY — never the CLI,
 * output, or any other adapter (dependency-cruiser enforced).
 *
 * This is an OPT-IN, installed tool (NOT in `bundled-tools.manifest.json`): the
 * host never imports this runtime; an `opensip gitleaks` invocation forks a worker
 * that re-discovers + imports it and runs the handler. Installed tools are
 * deny-by-default — a run needs `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` to include the
 * gitleaks id.
 */

import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter } from '@opensip-cli/external-tool-adapter';

import { parseGitleaksJson } from './parse-gitleaks-json.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

/** Human/aliased identity (`opensip gitleaks` / `opensip secrets`). */
export const GITLEAKS_IDENTITY: ToolIdentity = {
  name: 'gitleaks',
  aliases: ['secrets'],
};

/** Stable UUID identity (ADR-0048); mirrors `opensipTools.stableId` in package.json. */
export const GITLEAKS_STABLE_ID = 'cd08f737-ce8e-4813-9259-b4ffeb954268';

/**
 * Normalize the `gitleaks version` stdout to a bare semver. Gitleaks prints
 * either `8.18.4` or `v8.18.4` (and, on some builds, a multi-line banner); take
 * the first semver-shaped token and strip a leading `v`.
 *
 * VERIFY-against-installed-binary: exact `gitleaks version` output format.
 */
export function parseGitleaksVersion(stdout: string): string {
  // Fully bounded ({1,5} digit runs, {1,2} dotted segments) so the matcher is
  // linear — major.minor[.patch], optional leading `v`.
  const match = /v?(\d{1,5}(?:\.\d{1,5}){1,2})/.exec(stdout);
  return match?.[1] ?? stdout.trim();
}

/**
 * Build the gitleaks scan argv (no shell — args are passed to `execFile`). Scans
 * the project working tree (`detect --no-git --source <root>`) and writes a JSON
 * report to the host-owned artifact path the substrate composes for this run.
 *
 * VERIFY-against-installed-binary: `detect --no-git --source <root>` scans files
 * on disk (incl. uncommitted) rather than git history; v8.19 renamed the verb to
 * `gitleaks dir <root>`.
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  return [
    'detect',
    '--no-git',
    '--source',
    ctx.projectRoot,
    '--report-format',
    'json',
    '--report-path',
    ctx.artifactPath('gitleaks.json'),
  ];
}

/**
 * A3: build gitleaks's exclusion of opensip's own `.runtime` artifact store.
 *
 * gitleaks has NO CLI path-exclude, so we generate a `--config` allowlist that
 * EXTENDS the default ruleset (secret detection still runs) and allowlists any
 * file under `opensip-cli/.runtime`. Without this, a raw `Secret`/`Match` in a
 * prior run's JSON report is re-detected with a new runId in its path → a net-new
 * message-hash fingerprint every run → permanently degraded `--gate-compare`.
 *
 * The leading `# opensip-cli A3 exclude:` marker is load-bearing for the
 * deterministic worker-E2E fake (it honors the SAME injected exclusion the real
 * binary reads from the allowlist). VERIFY-against-installed-binary: gitleaks
 * allowlist `paths` regex semantics (matched against the reported file path).
 */
export function buildGitleaksExclude(input: {
  readonly excludePath: string;
  readonly configPath: (name: string) => string;
}): { readonly args: readonly string[]; readonly configFile: { path: string; contents: string } } {
  const path = input.configPath('gitleaks-exclude.toml');
  const contents = [
    '# opensip-cli A3 exclude: opensip-cli/.runtime',
    '[extend]',
    'useDefault = true',
    '',
    '[allowlist]',
    'description = "opensip-cli: skip the .runtime artifact store"',
    "paths = ['''(^|/)opensip-cli/\\.runtime(/|$)''']",
    '',
  ].join('\n');
  return { args: ['--config', path], configFile: { path, contents } };
}

/**
 * The gitleaks external-tool adapter `Tool`. The host loads it by name through
 * the installed-tool worker-dispatch path (the barrel re-exports it as `tool`).
 */
export const tool: Tool = defineExternalToolAdapter({
  identity: GITLEAKS_IDENTITY,
  metadata: {
    id: GITLEAKS_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Secret scanning via Gitleaks',
    adapterPackage: '@opensip-cli/tool-gitleaks',
  },
  binary: {
    command: 'gitleaks',
    versionArgs: ['version'],
    versionParse: parseGitleaksVersion,
    // `detect --no-git --source` is the stable filesystem-scan invocation; the
    // renamed `gitleaks dir` verb is v8.19+. VERIFY-against-installed-binary.
    minVersion: '8.18.0',
    // Operator pin (config `binaries.gitleaks.path` / `OPENSIP_GITLEAKS_BIN`)
    // beats PATH; resolution never fetches a binary.
    resolution: ['config', 'path'],
    installHint:
      'Install gitleaks: https://github.com/gitleaks/gitleaks#installing (brew install gitleaks)',
  },
  // Gitleaks scans local files via execFile — no network, no credentials.
  network: 'local-only',
  commands: [
    {
      name: 'scan',
      description: 'Scan the project working tree for committed secrets (Gitleaks)',
      args: buildScanArgs,
      output: { kind: 'json', path: 'gitleaks.json' },
      // ADR-0091 Phase-0 decision 4: `0` clean, `1` findings, `>=2` fault. Gitleaks
      // ALSO exits 1 on an internal fatal — the substrate disambiguates by artifact
      // presence + JSON-parseability (exit 1 + valid report ⇒ findings; exit 1 +
      // missing/garbage ⇒ fault).
      exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
      parse: parseGitleaksJson,
      // A3: never re-detect secrets in opensip's OWN persisted reports under
      // `.runtime/` (see {@link buildGitleaksExclude}).
      excludeScan: buildGitleaksExclude,
    },
  ],
  // Scanner output is line-volatile → the line-shift-tolerant message hash, not
  // the host `ruleId|file|line|col` default. Stamped worker-side in the run loop.
  fingerprintStrategy: 'message-hash',
});
