import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import { parseCargoClippyJsonLines } from './parse-cargo-clippy-json-lines.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const CARGO_CLIPPY_IDENTITY: ToolIdentity = {
  name: 'cargo-clippy',
  aliases: ['clippy'],
};
export const CARGO_CLIPPY_STABLE_ID = '66cb4afb-783c-42e7-b893-bb922ff8a72c';

/**
 * Build the CLI args for `cargo clippy` with JSON diagnostics across all targets
 * and features.
 *
 * Uses a per-run `--target-dir` under the host artifact store so warm project
 * `target/` caches cannot hide diagnostics (clippy only re-emits messages for
 * crates it recompiles). Slightly slower; gate-honest.
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  // --offline matches network: local-only — fail closed when registry deps missing.
  // --target-dir forces recompile under a cold per-run dir (deterministic findings).
  const targetDir = ctx.artifactPath('cargo-target');
  return [
    'clippy',
    '--offline',
    '--message-format=json',
    '--all-targets',
    '--all-features',
    '--target-dir',
    targetDir,
  ];
}

export const tool: Tool = defineExternalToolAdapter({
  identity: CARGO_CLIPPY_IDENTITY,
  metadata: {
    id: CARGO_CLIPPY_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description:
      'Rust lint diagnostics via cargo clippy (note: warm target/ cache can hide diagnostics — use a cold cache or CARGO_TARGET_DIR for deterministic gate-compare)',
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
  languages: ['rust'],
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
