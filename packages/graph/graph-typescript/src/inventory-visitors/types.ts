/**
 * InventoryVisitor signature alias (PR-5).
 *
 * Six of the seven inventory visitors (function-declaration,
 * arrow-function, method-declaration, constructor-declaration,
 * getter-setter, function-expression) conform to this shape.
 *
 * `module-init.ts` is the deliberate outlier — it walks all top-level
 * statements of a SourceFile and synthesizes one occurrence per file,
 * rather than dispatching on a single node. It does not implement
 * InventoryVisitor; PR-5 calls this out explicitly.
 */

import type { FunctionOccurrence } from '@opensip-tools/graph';
import type ts from 'typescript';


/** Per-source-file context carried through every inventory visitor invocation. */
export interface VisitorContext {
  readonly sourceFile: ts.SourceFile;
  readonly projectDirAbs: string;
  readonly filePathProjectRel: string;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
  /** Class node currently being walked (set when inside a class declaration). */
  readonly enclosingClass: string | null;
}

export type InventoryVisitor<N extends ts.Node = ts.Node> = (
  node: N,
  ctx: VisitorContext,
) => FunctionOccurrence | null;
