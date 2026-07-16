import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const CPPCHECK_IDENTITY: ToolIdentity = { name: 'cppcheck' };
export const CPPCHECK_STABLE_ID = 'dafe9acd-77c5-4055-a01c-05950c15d5f1';

function projectInput(projectRoot: string): readonly string[] {
  const compileCommands = join(projectRoot, 'compile_commands.json');
  // Prefer relative --project so paths stay portable under cwd=projectRoot.
  if (existsSync(compileCommands)) return ['--project=compile_commands.json'];
  return ['.'];
}

/**
 * Build the CLI args for a Cppcheck scan that writes SARIF to the `cppcheck.sarif`
 * artifact path. Prefers a `compile_commands.json` project when present (accurate
 * include/define resolution) and otherwise falls back to scanning the project root.
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  return [
    '--enable=warning,style,performance,portability,information',
    '--inline-suppr',
    '--output-format=sarif',
    `--output-file=${ctx.artifactPath('cppcheck.sarif')}`,
    ...projectInput(ctx.projectRoot),
  ];
}

/** Build the `-i <path>` args that exclude a path from a Cppcheck scan. */
export function buildCppcheckExclude(input: { readonly excludePath: string }): {
  readonly args: readonly string[];
} {
  // Relative path matches compile_commands entries and relative scan roots.
  const normalized = input.excludePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const relativeSegment = normalized.includes('opensip-cli/.runtime')
    ? 'opensip-cli/.runtime'
    : normalized.split('/').filter(Boolean).slice(-2).join('/') || normalized;
  return { args: ['-i', relativeSegment] };
}

export const tool: Tool = defineExternalToolAdapter({
  identity: CPPCHECK_IDENTITY,
  metadata: {
    id: CPPCHECK_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'C/C++ static analysis via Cppcheck',
    adapterPackage: '@opensip-cli/tool-cppcheck',
  },
  binary: {
    command: 'cppcheck',
    versionArgs: ['--version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '2.16.0',
    resolution: ['config', 'path'],
    installHint: 'Install cppcheck: https://cppcheck.sourceforge.io/ (brew install cppcheck)',
  },
  network: 'local-only',
  languages: ['cpp'],
  commands: [
    {
      name: 'scan',
      description: 'Run Cppcheck and normalize SARIF diagnostics',
      args: buildScanArgs,
      output: { kind: 'sarif', path: 'cppcheck.sarif' },
      exitCodes: { ok: [0], findings: [], errorFrom: 1 },
      excludeScan: buildCppcheckExclude,
    },
  ],
  fingerprintStrategy: 'message-hash',
});
