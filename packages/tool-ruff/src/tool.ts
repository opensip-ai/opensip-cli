import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import { parseRuffJson } from './parse-ruff-json.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const RUFF_IDENTITY: ToolIdentity = { name: 'ruff' };
export const RUFF_STABLE_ID = '16419cb0-553b-4bcb-a544-3099c6092480';

export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  return [
    'check',
    '--output-format',
    'json',
    '--output-file',
    ctx.artifactPath('ruff.json'),
    ctx.projectRoot,
  ];
}

export function buildRuffExclude(input: { readonly excludePath: string }): {
  readonly args: readonly string[];
} {
  return { args: ['--exclude', input.excludePath] };
}

export const tool: Tool = defineExternalToolAdapter({
  identity: RUFF_IDENTITY,
  metadata: {
    id: RUFF_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Python linting via Ruff',
    adapterPackage: '@opensip-cli/tool-ruff',
  },
  binary: {
    command: 'ruff',
    versionArgs: ['--version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '0.5.0',
    resolution: ['config', 'path'],
    installHint: 'Install ruff: https://docs.astral.sh/ruff/installation/ (brew install ruff)',
  },
  network: 'local-only',
  commands: [
    {
      name: 'scan',
      description: 'Run Ruff checks and normalize diagnostics',
      args: buildScanArgs,
      output: { kind: 'json', path: 'ruff.json' },
      parse: parseRuffJson,
      exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
      excludeScan: buildRuffExclude,
    },
  ],
  fingerprintStrategy: 'message-hash',
});
