/**
 * Stage 1 — Inventory.
 *
 * Walks every file's AST and emits a complete catalog of callable
 * functions. No edges, no resolution. Just "every function that
 * exists, with its metadata."
 */

import { relative, sep } from 'node:path';

import { logger } from '@opensip-tools/core';
import ts from 'typescript';

import { synthesizeModuleInit } from './inventory-visitors/module-init.js';
import { dispatchVisitor } from './walk.js';

import type { Catalog, FunctionOccurrence, ParseError } from '../types.js';
import type { VisitorContext } from './inventory-visitors/types.js';

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

export function buildInventory(input: InventoryInput): InventoryOutput {
  logger.info({
    evt: 'graph.inventory.start',
    module: 'graph:inventory',
    files: input.files.length,
  });

  const program = ts.createProgram({
    rootNames: [...input.files],
    options: input.compilerOptions,
  });

  // Force binder to run so parent pointers are set on every node;
  // visitors and resolvers walk parent chains. Phase 5 of
  // docs/plans/graph-performance-improvements.md spiked dropping this
  // call: the timing looked dramatic (14 s → 1.2 s) but the catalog
  // was wrong because Stage 1 visitors silently failed on undefined
  // parents. Switching to per-file `ts.setParentRecursive` produced a
  // correct catalog but ran in the same total wall-clock — the binder
  // cost simply moved from Stage 1 to Stage 2's first
  // `getSymbolAtLocation` call. No net win; left as-is.
  program.getTypeChecker();

  // Use a null-prototype object so reserved identifier names like
  // "constructor", "toString", "hasOwnProperty" can safely be used
  // as keys without colliding with Object.prototype.
  const functions: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<string, FunctionOccurrence[]>;
  const parseErrors: ParseError[] = [];
  const filesSet = new Set(input.files.map(normalizeForCompare));

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const sfPath = normalizeForCompare(sf.fileName);
    if (!filesSet.has(sfPath)) continue;
    try {
      collectFromFile(sf, input.projectDirAbs, functions);
    } catch (error) {
      parseErrors.push({
        filePath: relative(input.projectDirAbs, sf.fileName),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: new Date().toISOString(),
    cacheKey: `ts-${ts.version}-${input.tsConfigPathAbs}`,
    functions,
  };

  const totalOccurrences = Object.values(functions).reduce((n, arr) => n + arr.length, 0);
  logger.info({
    evt: 'graph.inventory.complete',
    module: 'graph:inventory',
    files: input.files.length,
    occurrences: totalOccurrences,
    parseErrors: parseErrors.length,
  });

  return { catalog, program, parseErrors };
}

function collectFromFile(
  sourceFile: ts.SourceFile,
  projectDirAbs: string,
  out: Record<string, FunctionOccurrence[]>,
): void {
  const filePathProjectRel = relative(projectDirAbs, sourceFile.fileName)
    .split(sep)
    .join('/');

  const baseCtx: VisitorContext = {
    sourceFile,
    projectDirAbs,
    filePathProjectRel,
    inTestFile: isTestFile(filePathProjectRel),
    definedInGenerated: isGeneratedFile(filePathProjectRel),
    enclosingClass: null,
  };

  function record(occ: FunctionOccurrence): void {
    const list = out[occ.simpleName];
    if (list) {
      list.push(occ);
    } else {
      out[occ.simpleName] = [occ];
    }
  }

  function walk(node: ts.Node, ctx: VisitorContext): void {
    const occ = dispatchVisitor(node, ctx);
    if (occ) record(occ);

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const className = node.name?.text ?? '<anon-class>';
      const childCtx: VisitorContext = { ...ctx, enclosingClass: className };
      ts.forEachChild(node, (c) => { walk(c, childCtx); });
      return;
    }

    ts.forEachChild(node, (c) => { walk(c, ctx); });
  }

  walk(sourceFile, baseCtx);

  // Always synthesize one module-init per file.
  record(synthesizeModuleInit(sourceFile, baseCtx));
}

function normalizeForCompare(p: string): string {
  return p.split(sep).join('/');
}

function isTestFile(rel: string): boolean {
  return /\.test\.tsx?$|__tests__\//.test(rel);
}

function isGeneratedFile(rel: string): boolean {
  return /\bdist\/|\bbuild\/|\.generated\./.test(rel);
}
