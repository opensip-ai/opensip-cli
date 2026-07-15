import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigurationError, readPackageVersion } from '@opensip-cli/core';
import {
  defineExternalToolAdapter,
  parseFirstSemver,
  parseStdoutSarif,
} from '@opensip-cli/external-tool-adapter';

import type { Signal, Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

export const AST_GREP_IDENTITY: ToolIdentity = {
  name: 'ast-grep',
  aliases: ['sg'],
};
export const AST_GREP_STABLE_ID = 'ea5f288f-3049-42fc-af9f-959184282f2f';

const CONFIGS = ['sgconfig.yml', 'sgconfig.yaml', '.ast-grep.yml', '.ast-grep.yaml'] as const;

function requiredConfig(projectRoot: string): string {
  for (const candidate of CONFIGS) {
    const fullPath = join(projectRoot, candidate);
    if (existsSync(fullPath)) return fullPath;
  }
  throw new ConfigurationError(
    'ast-grep requires an sgconfig.yml, sgconfig.yaml, .ast-grep.yml, or .ast-grep.yaml file.',
    { code: 'ADAPTER.CONFIG.MISSING' },
  );
}

/**
 * Build the CLI args for an ast-grep `scan` that emits SARIF to stdout. Resolves
 * the required rule config (`sgconfig.yml`/`.ast-grep.yml`, etc.) from the project
 * root, throwing `ADAPTER.CONFIG.MISSING` when none exists — ast-grep has no
 * built-in ruleset, so a scan without a config would be a no-op.
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  return [
    'scan',
    '--config',
    requiredConfig(ctx.projectRoot),
    '--format',
    'sarif',
    ctx.projectRoot,
  ];
}

/**
 * Parse ast-grep's stdout SARIF into normalized signals, attributing each to the
 * running tool (`ctx.tool`) as the source.
 */
export function parseAstGrepSarif(
  raw: ParsedScannerOutput,
  ctx: AdapterRunContext,
): readonly Signal[] {
  return parseStdoutSarif(raw.raw, { source: ctx.tool });
}

/**
 * Build exclude args that keep ast-grep from scanning a path.
 * ast-grep uses gitignore-style `--globs` (`!` = exclude); there is no `--exclude`.
 */
export function buildAstGrepExclude(input: { readonly excludePath: string }): {
  readonly args: readonly string[];
} {
  // Prefer a recursive glob under the runtime path so nested prior-run artifacts
  // are skipped. Quote is not needed — args are passed as execFile argv.
  const pattern = input.excludePath.endsWith('/**')
    ? `!${input.excludePath}`
    : `!${input.excludePath}/**`;
  return { args: ['--globs', pattern] };
}

export const tool: Tool = defineExternalToolAdapter({
  identity: AST_GREP_IDENTITY,
  metadata: {
    id: AST_GREP_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Structural code scanning via ast-grep',
    adapterPackage: '@opensip-cli/tool-ast-grep',
  },
  binary: {
    command: 'ast-grep',
    versionArgs: ['--version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '0.25.0',
    resolution: ['config', 'path'],
    installHint: 'Install ast-grep: https://ast-grep.github.io/guide/quick-start.html',
  },
  network: 'local-only',
  // Polyglot / language-agnostic: matches every --lang discovery filter.
  languages: [],
  commands: [
    {
      name: 'scan',
      description: 'Scan the project with ast-grep rules',
      args: buildScanArgs,
      output: { kind: 'stdout', path: 'ast-grep.sarif' },
      parse: parseAstGrepSarif,
      exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
      excludeScan: buildAstGrepExclude,
    },
  ],
  fingerprintStrategy: 'message-hash',
});
