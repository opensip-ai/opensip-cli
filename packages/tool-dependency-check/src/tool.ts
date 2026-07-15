import { basename } from 'node:path';

import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const DEPENDENCY_CHECK_IDENTITY: ToolIdentity = {
  name: 'dependency-check',
  aliases: ['owasp-dependency-check'],
};
export const DEPENDENCY_CHECK_STABLE_ID = '78ea5c7a-e71d-425a-a3b2-dd36fa307e91';

/**
 * Offline-only analyzer disables so a local-only run never phone-homes to OSS Index
 * / Node Audit / Yarn / pnpm even when a pre-populated NVD DB is present. Pair with
 * `--noupdate` (no NVD feed refresh).
 */
const LOCAL_ONLY_ANALYZER_FLAGS = [
  '--disableOssIndex',
  '--disableNodeAudit',
  '--disableYarnAudit',
  '--disablePnpmAudit',
  // Maven Central enrichment phones home even with --noupdate; local-only
  // posture requires disabling it (may reduce Java CPE identity quality).
  '--disableCentral',
] as const;

export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  const artifact = ctx.artifactPath('dependency-check-report.sarif');
  return [
    '--project',
    basename(ctx.projectRoot),
    '--scan',
    ctx.projectRoot,
    '--format',
    'SARIF',
    // Full file path so the substrate always finds the expected SARIF name.
    '--out',
    artifact,
    '--noupdate',
    ...LOCAL_ONLY_ANALYZER_FLAGS,
  ];
}

/**
 * Dependency-Check `--exclude` takes Ant-style path patterns. An absolute dir
 * alone does not recursively skip nested contents — use a recursive Ant pattern
 * (double-star / opensip-cli/.runtime / double-star) so the whole runtime tree
 * is skipped.
 */
export function buildDependencyCheckExclude(input: { readonly excludePath: string }): {
  readonly args: readonly string[];
} {
  const normalized = input.excludePath.replace(/\\/g, '/').replace(/\/+$/, '');
  // Ant recursive pattern: match the runtime dir anywhere under the scan root.
  const pattern = normalized.includes('opensip-cli/.runtime')
    ? '**/opensip-cli/.runtime/**'
    : `**/${normalized.split('/').filter(Boolean).slice(-2).join('/')}/**`;
  return { args: ['--exclude', pattern] };
}

export const tool: Tool = defineExternalToolAdapter({
  identity: DEPENDENCY_CHECK_IDENTITY,
  metadata: {
    id: DEPENDENCY_CHECK_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Dependency vulnerability scanning via OWASP Dependency-Check',
    adapterPackage: '@opensip-cli/tool-dependency-check',
  },
  binary: {
    command: 'dependency-check',
    versionArgs: ['--version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '9.0.0',
    resolution: ['config', 'path'],
    installHint:
      'Install Dependency-Check: https://owasp.org/www-project-dependency-check/ and pre-populate its vulnerability database before offline scans.',
  },
  network: 'local-only',
  // Polyglot / language-agnostic: matches every --lang discovery filter.
  languages: [],
  commands: [
    {
      name: 'scan',
      description: 'Scan dependencies with OWASP Dependency-Check',
      args: buildScanArgs,
      output: { kind: 'sarif', path: 'dependency-check-report.sarif' },
      exitCodes: { ok: [0], findings: [], errorFrom: 1 },
      excludeScan: buildDependencyCheckExclude,
    },
  ],
  fingerprintStrategy: 'message-hash',
});
