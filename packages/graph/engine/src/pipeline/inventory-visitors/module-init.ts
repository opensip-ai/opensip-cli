/**
 * Synthesizes one `<module-init>` occurrence per file.
 *
 * Per spec §2.2: "produces ONE module-init occurrence per file, owning
 * all top-level call sites discovered in stage 2."
 *
 * PR-5 documents that this visitor is the deliberate outlier — it does
 * not implement the InventoryVisitor signature because it walks all
 * top-level statements rather than dispatching on a single node.
 */

import { digestSyntheticBody } from '../inventory-helpers/hash-body.js';
import { synthesizeModuleInitName } from '../inventory-helpers/synthesize-name.js';

import type { VisitorContext } from './types.js';
import type { FunctionOccurrence } from '../../types.js';
import type ts from 'typescript';

export function synthesizeModuleInit(
  sourceFile: ts.SourceFile,
  ctx: VisitorContext,
): FunctionOccurrence {
  // Hash the file's top-level statement-text concatenation. Every
  // top-level statement contributes; per-function bodies do not (they
  // get their own occurrences).
  const topLevelText = sourceFile.statements
    .map((s) => s.getText(sourceFile))
    .join('\n');
  const name = synthesizeModuleInitName(ctx.filePathProjectRel);
  const digest = digestSyntheticBody(`${ctx.filePathProjectRel}\n${topLevelText}`);
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    simpleName: name,
    qualifiedName: `${ctx.filePathProjectRel.replace(/\.tsx?$/, '')}.<module-init>`,
    filePath: ctx.filePathProjectRel,
    line: 1,
    column: 0,
    endLine: sourceFile.getLineAndCharacterOfPosition(sourceFile.getEnd()).line + 1,
    kind: 'module-init',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: ctx.inTestFile,
    definedInGenerated: ctx.definedInGenerated,
    calls: [],
  };
}
