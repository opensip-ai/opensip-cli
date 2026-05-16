/**
 * Stage 1 — Inventory (skeleton; implemented in P1).
 *
 * Walks every file's AST and emits a complete catalog of callable
 * functions. No edges, no resolution. Just "every function that
 * exists, with its metadata."
 */

import type { Catalog, ParseError } from '../types.js';
import type ts from 'typescript';


export interface InventoryInput {
  readonly projectDirAbs: string;
  readonly files: readonly string[];
  readonly compilerOptions: ts.CompilerOptions;
  readonly tsConfigPathAbs: string;
}

export interface InventoryOutput {
  readonly catalog: Catalog;
  readonly program: ts.Program;
  readonly parseErrors: readonly ParseError[];
}

export function buildInventory(_input: InventoryInput): InventoryOutput {
  throw new Error('buildInventory: not implemented (Phase P1).');
}
