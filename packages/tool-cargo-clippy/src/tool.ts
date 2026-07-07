import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import { parseCargoClippyJsonLines } from './parse-cargo-clippy-json-lines.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const CARGO_CLIPPY_IDENTITY: ToolIdentity = { name: 'cargo-clippy', aliases: ['clippy'] };
export const CARGO_CLIPPY_STABLE_ID = '66cb4afb-783c-42e7-b893-bb922ff8a72c';

export function buildScanArgs(_ctx: AdapterRunContext): readonly string[] {
  // NOTE (build cache): `cargo clippy` only emits `compiler-message` records for
  // crates it actually (re)compiles. With a warm target cache a repeat run emits
  // zero diagnostics even though the lints still hold — so a stable `--gate-compare`
  // requires a cold cache (fresh checkout / CI without target caching). See the
  // package README's determinism caveat.
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
      // clippy exits 0 (clean, even with warnings) or 101 (deny-level lints /
      // compile error); it never exits 1. Treat any nonzero with parseable
      // diagnostics as findings rather than faulting and swallowing them.
      exitCodes: { ok: [0], findings: [], findingsFromNonzero: true },
    },
  ],
  fingerprintStrategy: 'message-hash',
});
