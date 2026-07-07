import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import { parseCargoDenyJsonLines } from './parse-cargo-deny-json-lines.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const CARGO_DENY_IDENTITY: ToolIdentity = {
  name: 'cargo-deny',
  aliases: ['deny'],
};
export const CARGO_DENY_STABLE_ID = '93d06787-b067-468b-bba0-1086c876c5f7';

export function buildScanArgs(_ctx: AdapterRunContext): readonly string[] {
  return ['check', '--format', 'json'];
}

export const tool: Tool = defineExternalToolAdapter({
  identity: CARGO_DENY_IDENTITY,
  metadata: {
    id: CARGO_DENY_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Rust dependency policy checks via cargo-deny',
    adapterPackage: '@opensip-cli/tool-cargo-deny',
  },
  binary: {
    command: 'cargo-deny',
    versionArgs: ['--version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '0.14.0',
    resolution: ['config', 'path'],
    installHint: 'Install cargo-deny: https://embarkstudios.github.io/cargo-deny/',
  },
  network: 'networked',
  commands: [
    {
      name: 'scan',
      description: 'Run cargo-deny policy checks',
      args: buildScanArgs,
      output: { kind: 'stdout', path: 'cargo-deny.jsonl' },
      parse: parseCargoDenyJsonLines,
      // cargo-deny's exit code is an OR of per-check category bits (advisories 1,
      // bans 2, licenses 4, sources 8, …), so no single "findings" code exists.
      // Any nonzero with parseable diagnostics is a findings verdict.
      exitCodes: { ok: [0], findings: [], findingsFromNonzero: true },
    },
  ],
  fingerprintStrategy: 'message-hash',
});
