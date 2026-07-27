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

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { currentLogger, readPackageVersion } from '@opensip-cli/core';
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

const PROJECT_GITLEAKS_CONFIGS = ['.gitleaks.toml', 'gitleaks.toml'] as const;

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
 * the project working tree (`detect --no-git --source .`) and writes a JSON
 * report to the host-owned artifact path the substrate composes for this run.
 *
 * The substrate runs the scanner with `cwd = projectRoot`; the relative source
 * keeps Gitleaks's reported file paths and OpenSIP fingerprints portable across
 * checkout locations. VERIFY-against-installed-binary: `detect --no-git` scans
 * files on disk (incl. uncommitted) rather than git history; v8.19 renamed the
 * verb to `gitleaks dir`.
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  return [
    'detect',
    '--no-git',
    '--source',
    '.',
    '--report-format',
    'json',
    '--report-path',
    ctx.artifactPath('gitleaks.json'),
  ];
}

/**
 * Project-root candidates that may carry a gitleaks config. The substrate's
 * `excludePath` is always `<project>/opensip-cli/.runtime` (see
 * `resolveProjectPaths`), so the project root is two directories up.
 */
function projectRootFromRuntimeExclude(excludePath: string): string {
  const trimmed = excludePath.replace(/[/\\]+$/, '');
  const parts = trimmed.split(/[/\\]/);
  if (parts.at(-1) === '.runtime' && parts.at(-2) === 'opensip-cli') {
    return dirname(dirname(trimmed));
  }
  return dirname(trimmed);
}

/**
 * Prefer extending the project's own gitleaks config when present, so project
 * rules/allowlists are not replaced by a bare `useDefault = true` overlay.
 * Falls back to the built-in ruleset when the project has no config file.
 */
function resolveExtendSource(
  projectRoot: string,
): { kind: 'default' } | { kind: 'path'; path: string } {
  for (const name of PROJECT_GITLEAKS_CONFIGS) {
    const fullPath = join(projectRoot, name);
    if (existsSync(fullPath)) return { kind: 'path', path: fullPath };
  }
  return { kind: 'default' };
}

const RUNTIME_ALLOWLIST_PATH = "'''(^|/)opensip-cli/\\.runtime(/|$)'''";
const EXCLUSION_MARKER = '# opensip-cli A3 exclude: opensip-cli/.runtime';
const LEGACY_ALLOWLIST_HEADER = /(?:^|\r?\n)[ \t]*\[allowlist\][ \t]*(?:#[^\r\n]*)?(?=\r?\n|$)/;
const MODERN_ALLOWLIST_HEADER =
  /(?:^|\r?\n)[ \t]*\[\[allowlists\]\][ \t]*(?:#[^\r\n]*)?(?=\r?\n|$)/;
const MODERN_ALLOWLIST = [
  '[[allowlists]]',
  'description = "opensip-cli: skip the .runtime artifact store"',
  `paths = [${RUNTIME_ALLOWLIST_PATH}]`,
  '',
].join('\n');
const LEGACY_ALLOWLIST = [
  '[allowlist]',
  'description = "opensip-cli: skip the .runtime artifact store"',
  `paths = [${RUNTIME_ALLOWLIST_PATH}]`,
  '',
].join('\n');

function lineBreakLengthAt(value: string, index: number): number {
  if (value.startsWith('\r\n', index)) return 2;
  if (value[index] === '\n') return 1;
  return 0;
}

/**
 * Add the runtime path to an existing legacy global allowlist. A second
 * `[allowlist]` table is invalid TOML, while mixing it with `[[allowlists]]`
 * is explicitly rejected by Gitleaks.
 */
function mergeLegacyRuntimePath(projectConfig: string): string {
  const header = LEGACY_ALLOWLIST_HEADER.exec(projectConfig);
  if (header === null) return projectConfig;

  const headerEnd = header.index + header[0].length;
  const lineBreakLength = lineBreakLengthAt(projectConfig, headerEnd);
  const sectionStart = headerEnd + lineBreakLength;
  const nextHeader = /^[ \t]*\[/m.exec(projectConfig.slice(sectionStart));
  const sectionEnd = nextHeader === null ? projectConfig.length : sectionStart + nextHeader.index;
  const section = projectConfig.slice(sectionStart, sectionEnd);
  const paths = /(?:^|\r?\n)[ \t]*(?:paths|"paths"|'paths')[ \t]*=[ \t]*\[/.exec(section);
  if (paths !== null) {
    const openBracket = sectionStart + paths.index + paths[0].lastIndexOf('[');
    return (
      projectConfig.slice(0, openBracket + 1) +
      `${RUNTIME_ALLOWLIST_PATH}, ` +
      projectConfig.slice(openBracket + 1)
    );
  }

  const newline = projectConfig.includes('\r\n') ? '\r\n' : '\n';
  const insertion = `paths = [${RUNTIME_ALLOWLIST_PATH}]${newline}`;
  const prefix = lineBreakLength === 0 ? newline : '';
  return (
    projectConfig.slice(0, sectionStart) + prefix + insertion + projectConfig.slice(sectionStart)
  );
}

function defaultExclusionConfig(): string {
  return [EXCLUSION_MARKER, '[extend]', 'useDefault = true', '', LEGACY_ALLOWLIST].join('\n');
}

function errorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unknown';
}

function warnConfigFallback(
  path: string,
  condition: 'config-read-failed' | 'config-too-large',
  detail: Readonly<Record<string, unknown>>,
): void {
  currentLogger().warn({
    evt: 'gitleaks.project_config.degraded',
    module: 'tool-gitleaks',
    condition,
    config: basename(path),
    ...detail,
  });
}

function readProjectConfig(path: string): string | undefined {
  try {
    // Config files are small TOML; reject oversized inputs before reading.
    const MAX_GITLEAKS_CONFIG_BYTES = 1_048_576;
    const size = statSync(path).size;
    if (size > MAX_GITLEAKS_CONFIG_BYTES) {
      warnConfigFallback(path, 'config-too-large', { size, limit: MAX_GITLEAKS_CONFIG_BYTES });
      return undefined;
    }
    return readFileSync(path, 'utf8').trimEnd();
  } catch (error) {
    // Best-effort: an unreadable/oversized project gitleaks config falls back
    // to the default exclusion config (see addRuntimeExclusion) rather than
    // failing the scan — but the swallow must stay observable.
    warnConfigFallback(path, 'config-read-failed', { errorCode: errorCode(error) });
    return undefined;
  }
}

function addRuntimeExclusion(projectConfig: string): string {
  if (LEGACY_ALLOWLIST_HEADER.test(projectConfig)) {
    return [EXCLUSION_MARKER, mergeLegacyRuntimePath(projectConfig)].join('\n');
  }
  const allowlistBlock = MODERN_ALLOWLIST_HEADER.test(projectConfig)
    ? MODERN_ALLOWLIST
    : LEGACY_ALLOWLIST;
  return [EXCLUSION_MARKER, projectConfig, '', allowlistBlock].join('\n');
}

/**
 * A3: build gitleaks's exclusion of opensip's own `.runtime` artifact store.
 * (Not the shared `buildScannerExclude`: this builder derives the PROJECT ROOT
 * from the exclude path — to extend the project's own gitleaks config — which
 * the shared helper deliberately does not.)
 *
 * gitleaks has NO CLI path-exclude, so we generate a `--config` allowlist that
 * EXTENDS either the project config (when `.gitleaks.toml` / `gitleaks.toml` is
 * present) or the default ruleset, and allowlists any file under
 * `opensip-cli/.runtime`. Without this, a raw `Secret`/`Match` in a prior run's
 * JSON report is re-detected with a new runId in its path → a net-new
 * message-hash fingerprint every run → permanently degraded `--gate-compare`.
 *
 * The leading `# opensip-cli A3 exclude:` marker is load-bearing for the
 * deterministic worker-E2E fake (it honors the SAME injected exclusion the real
 * binary reads from the allowlist). VERIFY-against-installed-binary: gitleaks
 * allowlist `paths` regex semantics (matched against the reported file path).
 * `useDefault` and `path` cannot be set together — choose one extend source.
 */
export function buildGitleaksExclude(input: {
  readonly excludePath: string;
  readonly configPath: (name: string) => string;
}): {
  readonly args: readonly string[];
  readonly configFile: { path: string; contents: string };
} {
  const path = input.configPath('gitleaks-exclude.toml');
  const projectRoot = projectRootFromRuntimeExclude(input.excludePath);
  const extend = resolveExtendSource(projectRoot);
  // Flatten: never wrap project config in `[extend] path = ...` — that burns one
  // of gitleaks's maxExtendDepth=2 hops and can drop base/org rules. Inline the
  // project file (preserving its own extends) and append our runtime allowlist.
  // The singular form is supported by the adapter's minimum Gitleaks 8.18 and
  // remains backward-compatible in current Gitleaks. Use plural only when the
  // project already uses it; Gitleaks rejects mixed singular/plural forms.
  const projectConfig = extend.kind === 'path' ? readProjectConfig(extend.path) : undefined;
  const contents =
    projectConfig === undefined ? defaultExclusionConfig() : addRuntimeExclusion(projectConfig);
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
  // Polyglot / language-agnostic: matches every --lang discovery filter.
  languages: [],
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
