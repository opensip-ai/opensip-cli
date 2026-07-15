import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const SEMGREP_IDENTITY: ToolIdentity = { name: 'semgrep' };
export const SEMGREP_STABLE_ID = 'dbd7d730-8b53-4b2b-9a86-2ad4e98d098b';

const LOCAL_CONFIGS = [
  'semgrep.yml',
  'semgrep.yaml',
  '.semgrep.yml',
  '.semgrep.yaml',
  '.semgrep/semgrep.yml',
  '.semgrep/semgrep.yaml',
] as const;

function discoverLocalConfig(projectRoot: string): string | undefined {
  for (const candidate of LOCAL_CONFIGS) {
    const fullPath = join(projectRoot, candidate);
    if (existsSync(fullPath)) return fullPath;
  }
  return undefined;
}

/**
 * Build the CLI args for a Semgrep scan: use a discovered local rule config (or
 * `auto`) and write SARIF to the artifact path. Passes `--error` so Semgrep
 * exits nonzero on findings, keeping the exit-code model and SARIF in agreement.
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  const config = discoverLocalConfig(ctx.projectRoot) ?? 'auto';
  return [
    'scan',
    '--config',
    config,
    '--sarif',
    '--output',
    ctx.artifactPath('semgrep.sarif'),
    // `--error` makes semgrep exit nonzero on findings (spec 31a exit contract), so
    // the exit-code model and the SARIF report agree; without it findings exit 0.
    '--error',
    ctx.projectRoot,
  ];
}

/**
 * Build the exclude-path args for Semgrep. Semgrep's `--exclude` expects a
 * relative gitignore-style pattern (absolute paths are ineffective). Prefer the
 * project-relative runtime segment `opensip-cli/.runtime` when the host hands
 * the absolute runtime dir.
 */
export function buildSemgrepExclude(input: { readonly excludePath: string }): {
  readonly args: readonly string[];
} {
  const normalized = input.excludePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const relativeSegment = normalized.includes('opensip-cli/.runtime')
    ? 'opensip-cli/.runtime'
    : normalized.split('/').filter(Boolean).slice(-2).join('/');
  // Semgrep documents `--exclude` (not `--exclude-dir`); the relative segment is
  // the effective directory exclude under the scan root.
  return { args: ['--exclude', relativeSegment] };
}

export const tool: Tool = defineExternalToolAdapter({
  identity: SEMGREP_IDENTITY,
  metadata: {
    id: SEMGREP_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Static analysis via Semgrep',
    adapterPackage: '@opensip-cli/tool-semgrep',
  },
  binary: {
    command: 'semgrep',
    versionArgs: ['--version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '1.70.0',
    resolution: ['config', 'path'],
    installHint:
      'Install semgrep: https://semgrep.dev/docs/getting-started/ (brew install semgrep)',
  },
  network: 'networked',
  // Polyglot / language-agnostic: matches every --lang discovery filter.
  languages: [],
  commands: [
    {
      name: 'scan',
      description: 'Scan the project with Semgrep rules',
      args: buildScanArgs,
      output: { kind: 'sarif', path: 'semgrep.sarif' },
      exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
      excludeScan: buildSemgrepExclude,
    },
  ],
  fingerprintStrategy: 'message-hash',
});
