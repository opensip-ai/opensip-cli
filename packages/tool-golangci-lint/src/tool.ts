import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import { parseGolangciLintJson } from './parse-golangci-lint-json.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const GOLANGCI_LINT_IDENTITY: ToolIdentity = {
  name: 'golangci-lint',
  aliases: ['golangci'],
};
export const GOLANGCI_LINT_STABLE_ID = 'b46ee627-2dd6-42b6-9888-c9132b803167';

export function buildScanArgs(_ctx: AdapterRunContext): readonly string[] {
  return ['run', '--out-format', 'json'];
}

export function buildGolangciLintExclude(input: { readonly excludePath: string }): {
  readonly args: readonly string[];
} {
  return { args: ['--skip-dirs', input.excludePath] };
}

export const tool: Tool = defineExternalToolAdapter({
  identity: GOLANGCI_LINT_IDENTITY,
  metadata: {
    id: GOLANGCI_LINT_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Go lint aggregation via golangci-lint',
    adapterPackage: '@opensip-cli/tool-golangci-lint',
  },
  binary: {
    command: 'golangci-lint',
    versionArgs: ['--version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '1.50.0',
    resolution: ['config', 'path'],
    installHint: 'Install golangci-lint: https://golangci-lint.run/welcome/install/',
  },
  network: 'local-only',
  commands: [
    {
      name: 'scan',
      description: 'Run golangci-lint and normalize issues',
      args: buildScanArgs,
      output: { kind: 'stdout', path: 'golangci-lint.json' },
      parse: parseGolangciLintJson,
      exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
      excludeScan: buildGolangciLintExclude,
    },
  ],
  fingerprintStrategy: 'message-hash',
});
