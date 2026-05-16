/**
 * Stage 0 — Discover files (skeleton; implemented in P1).
 *
 * Walks tsconfig include/exclude and emits the absolute, realpath'd
 * source-file list for stage 1 to inventory.
 */

import type ts from 'typescript';

export interface DiscoveryInput {
  readonly projectDir: string;
  readonly tsConfigPath?: string;
}

export interface DiscoveryOutput {
  readonly projectDirAbs: string;
  readonly tsConfigPathAbs: string;
  readonly files: readonly string[];
  readonly compilerOptions: ts.CompilerOptions;
}

export function discoverFiles(_input: DiscoveryInput): DiscoveryOutput {
  throw new Error('discoverFiles: not implemented (Phase P1).');
}
