import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import { parseCargoClippyJsonLines } from './parse-cargo-clippy-json-lines.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const CARGO_CLIPPY_IDENTITY: ToolIdentity = { name: 'cargo-clippy', aliases: ['clippy'] };
export const CARGO_CLIPPY_STABLE_ID = '66cb4afb-783c-42e7-b893-bb922ff8a72c';

export function buildScanArgs(_ctx: AdapterRunContext): readonly string[] {
  return ['clippy', '--message-format=json', '--all-targets', '--all-features'];
}

export const tool: Tool = defineExternalToolAdapter({
  identity: CARGO_CLIPPY_IDENTITY,
  metadata: {
    id: CARGO_CLIPPY_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Rust lint diagnostics via cargo clippy',
    adapterPackage: '@opensip-cli/tool-cargo-clippy',
  },
  binary: {
    command: 'cargo',
    versionArgs: ['clippy', '--version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '0.1.0',
    envVar: 'OPENSIP_CARGO_CLIPPY_BIN',
    resolution: ['config', 'path'],
    installHint: 'Install clippy: rustup component add clippy',
  },
  network: 'local-only',
  commands: [
    {
      name: 'scan',
      description: 'Run cargo clippy and normalize compiler diagnostics',
      args: buildScanArgs,
      output: { kind: 'stdout', path: 'cargo-clippy.jsonl' },
      parse: parseCargoClippyJsonLines,
      exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
    },
  ],
  fingerprintStrategy: 'message-hash',
});
