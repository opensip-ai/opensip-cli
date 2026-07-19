import { readPackageVersion } from '@opensip-cli/core';
import {
  buildScannerExclude,
  defineExternalToolAdapter,
  parseFirstSemver,
} from '@opensip-cli/external-tool-adapter';

import { parseBanditJson } from './parse-bandit-json.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const BANDIT_IDENTITY: ToolIdentity = { name: 'bandit' };
export const BANDIT_STABLE_ID = '9dccda56-64ca-4d54-9c59-fea8302bebfa';

/**
 * Bandit's built-in `-x` / `--exclude` defaults (from `bandit.core.constants.EXCLUDE`).
 * Passing `-x` replaces that list, so A3 exclusions MUST re-include these or Bandit
 * will start scanning VCS/cache trees that the stock CLI would skip.
 */
export const BANDIT_DEFAULT_EXCLUDES = [
  '.svn',
  'CVS',
  '.bzr',
  '.hg',
  '.git',
  '__pycache__',
  '.tox',
  '.eggs',
  '*.egg',
] as const;

/**
 * Build the CLI args for a recursive Bandit scan of the project root, writing its
 * JSON report to the `bandit.json` artifact path for the parser to consume.
 * Scan `.` (cwd is already projectRoot) so reported paths and `-x` basenames stay
 * project-relative — absolute `-r` makes stock excludes like `.git` ineffective.
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  return ['-r', '.', '-f', 'json', '-o', ctx.artifactPath('bandit.json')];
}

/**
 * Build the `-x <paths>` args that exclude Bandit's defaults PLUS the host runtime
 * path. Bandit takes a single comma-separated `-x` value and REPLACES its default
 * exclude list, so both must be present. Runtime path is project-relative so it
 * matches paths under a relative scan root.
 */
export function buildBanditExclude(input: { readonly excludePath: string }): {
  readonly args: readonly string[];
} {
  return buildScannerExclude(input, {
    flag: '-x',
    pattern: (segment) => [...BANDIT_DEFAULT_EXCLUDES, segment].join(','),
  });
}

export const tool: Tool = defineExternalToolAdapter({
  identity: BANDIT_IDENTITY,
  metadata: {
    id: BANDIT_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Python security scanning via Bandit',
    adapterPackage: '@opensip-cli/tool-bandit',
  },
  binary: {
    command: 'bandit',
    versionArgs: ['--version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '1.7.0',
    resolution: ['config', 'path'],
    installHint: 'Install bandit: https://bandit.readthedocs.io/en/latest/start.html',
  },
  network: 'local-only',
  languages: ['python'],
  commands: [
    {
      name: 'scan',
      description: 'Scan Python source for security issues with Bandit',
      args: buildScanArgs,
      output: { kind: 'json', path: 'bandit.json' },
      parse: parseBanditJson,
      exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
      excludeScan: buildBanditExclude,
    },
  ],
  fingerprintStrategy: 'message-hash',
});
