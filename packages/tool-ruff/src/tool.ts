import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import { parseRuffJson } from './parse-ruff-json.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const RUFF_IDENTITY: ToolIdentity = { name: 'ruff' };
export const RUFF_STABLE_ID = '16419cb0-553b-4bcb-a544-3099c6092480';

/**
 * Build the CLI args for a Ruff scan: `check` the project working tree (`.`,
 * relative to the process cwd which the substrate sets to `projectRoot`) and
 * write JSON diagnostics to the artifact path. Prefer `.` over an absolute root
 * so reported paths stay project-relative.
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  return [
    'check',
    '--output-format',
    'json',
    '--output-file',
    ctx.artifactPath('ruff.json'),
    '.',
  ];
}

/**
 * Build the exclude-path args for Ruff by passing the host's exclude path
 * through Ruff's `--exclude` flag.
 */
export function buildRuffExclude(input: { readonly excludePath: string }): {
  readonly args: readonly string[];
} {
  // Ruff exclude patterns are project-relative globs; absolute host paths no-op.
  const normalized = input.excludePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const relativeSegment = normalized.includes('opensip-cli/.runtime')
    ? 'opensip-cli/.runtime'
    : (normalized.split('/').filter(Boolean).slice(-2).join('/') || normalized);
  // --extend-exclude ADDS to defaults/config; --exclude REPLACES them (would
  // scan .venv / node_modules / .git). Same class of footgun Bandit fixed for -x.
  return { args: ['--extend-exclude', relativeSegment] };
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
  languages: ['python'],
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
