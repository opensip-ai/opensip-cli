import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const PMD_IDENTITY: ToolIdentity = { name: 'pmd' };
export const PMD_STABLE_ID = 'e770734d-5708-4f1a-9399-f4ced6424a53';
const DEFAULT_RULESET = 'rulesets/java/quickstart.xml';

/**
 * Build the CLI args for a PMD 7 scan: `check` the project root against the
 * bundled Java quickstart ruleset and write SARIF to the artifact path.
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  return [
    'check',
    '-d',
    ctx.projectRoot,
    '-R',
    DEFAULT_RULESET,
    '-f',
    'sarif',
    '-r',
    ctx.artifactPath('pmd.sarif'),
  ];
}

export const tool: Tool = defineExternalToolAdapter({
  identity: PMD_IDENTITY,
  metadata: {
    id: PMD_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Java source analysis via PMD',
    adapterPackage: '@opensip-cli/tool-pmd',
  },
  binary: {
    command: 'pmd',
    versionArgs: ['--version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    // The `check` subcommand + `-f sarif` invocation below is PMD 7 CLI; PMD 6.x
    // has no `check` verb, so 7.0.0 is the real floor.
    minVersion: '7.0.0',
    resolution: ['config', 'path'],
    installHint: 'Install PMD: https://pmd.github.io/ (brew install pmd)',
  },
  network: 'local-only',
  languages: ['java'],
  commands: [
    {
      name: 'scan',
      description: 'Run PMD Java rules and normalize SARIF',
      args: buildScanArgs,
      output: { kind: 'sarif', path: 'pmd.sarif' },
      exitCodes: { ok: [0], findings: [4], errorFrom: 1 },
    },
  ],
  fingerprintStrategy: 'message-hash',
});
