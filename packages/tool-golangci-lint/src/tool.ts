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

/**
 * Build the CLI args for a golangci-lint scan: `run` with the JSON report
 * streamed to stdout (the golangci-lint v2 replacement for v1's `--out-format`).
 */
export function buildScanArgs(_ctx: AdapterRunContext): readonly string[] {
  // golangci-lint v2 replaced `--out-format json` with `--output.json.path`; use
  // `stdout` so the JSON report streams to stdout (output kind: 'stdout').
  return ['run', '--output.json.path=stdout'];
}

/**
 * Build the exclude-path args for golangci-lint — always none. golangci-lint
 * lints only `.go` files and `.runtime/` holds no Go source, and v2 dropped the
 * `--skip-dirs` flag (exclusion moved to config), so there is nothing to pass.
 */
export function buildGolangciLintExclude(input: { readonly excludePath: string }): {
  readonly args: readonly string[];
} {
  // v2 removed the `--skip-dirs` run flag (exclusion moved to config). golangci-lint
  // only lints `.go` files, and `.runtime/` holds no Go source, so there is nothing
  // to exclude at the CLI — emit no extra args.
  void input;
  return { args: [] };
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
    // The `--output.json.path` invocation is golangci-lint v2 CLI (v1 used
    // `--out-format`), so 2.0.0 is the floor.
    minVersion: '2.0.0',
    resolution: ['config', 'path'],
    installHint: 'Install golangci-lint: https://golangci-lint.run/welcome/install/',
  },
  network: 'local-only',
  languages: ['go'],
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
