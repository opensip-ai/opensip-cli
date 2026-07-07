import { basename, dirname } from 'node:path';

import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const DEPENDENCY_CHECK_IDENTITY: ToolIdentity = {
  name: 'dependency-check',
  aliases: ['owasp-dependency-check'],
};
export const DEPENDENCY_CHECK_STABLE_ID = '78ea5c7a-e71d-425a-a3b2-dd36fa307e91';

export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  const artifact = ctx.artifactPath('dependency-check-report.sarif');
  return [
    '--project',
    basename(ctx.projectRoot),
    '--scan',
    ctx.projectRoot,
    '--format',
    'SARIF',
    '--out',
    dirname(artifact),
    '--noupdate',
  ];
}

export function buildDependencyCheckExclude(input: { readonly excludePath: string }): {
  readonly args: readonly string[];
} {
  return { args: ['--exclude', input.excludePath] };
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
