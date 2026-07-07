import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigurationError, readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const SPOTBUGS_IDENTITY: ToolIdentity = { name: 'spotbugs' };
export const SPOTBUGS_STABLE_ID = '47a950e0-f631-4d80-aa35-02968ef97747';

function classTargets(projectRoot: string): readonly string[] {
  const candidates = [
    'target/classes',
    'build/classes/java/main',
    'build/classes',
    'out/production',
  ];
  return candidates
    .map((candidate) => join(projectRoot, candidate))
    .filter((path) => existsSync(path));
}

export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  const targets = classTargets(ctx.projectRoot);
  if (targets.length === 0) {
    throw new ConfigurationError(
      'spotbugs requires compiled Java classes (for example target/classes or build/classes/java/main).',
      { code: 'ADAPTER.CONFIG.MISSING_BUILD_OUTPUT' },
    );
  }
  return [
    '-textui',
    '-effort:max',
    '-low',
    '-sarif',
    '-output',
    ctx.artifactPath('spotbugs.sarif'),
    ...targets,
  ];
}

export const tool: Tool = defineExternalToolAdapter({
  identity: SPOTBUGS_IDENTITY,
  metadata: {
    id: SPOTBUGS_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Java bytecode analysis via SpotBugs',
    adapterPackage: '@opensip-cli/tool-spotbugs',
  },
  binary: {
    command: 'spotbugs',
    versionArgs: ['-version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '4.8.0',
    resolution: ['config', 'path'],
    installHint: 'Install SpotBugs: https://spotbugs.github.io/ (brew install spotbugs)',
  },
  network: 'local-only',
  commands: [
    {
      name: 'scan',
      description: 'Analyze compiled Java classes with SpotBugs',
      args: buildScanArgs,
      output: { kind: 'sarif', path: 'spotbugs.sarif' },
      exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
    },
  ],
  fingerprintStrategy: 'message-hash',
});
