/**
 * Stage 1 — Inventory.
 *
 * Public single-stage entry retained for tests and external callers
 * that want a one-shot "every callable function in this project,
 * with its metadata" without going through the orchestrator's
 * adapter-mediated pipeline.
 *
 * History: this module used to roll its own `ts.createProgram`,
 * file-walker, `isTestFile`/`isGeneratedFile` predicates, and AST
 * descent — a parallel copy of `walk.ts:walkFile`. The 2026-05-23
 * audit (M-1) flagged the duplication: same job, two copies, three
 * different `isTestFile` predicates drifting silently.
 *
 * Today this is a thin wrapper that delegates to the canonical
 * `parseProject` + `walkProgram` pipeline (the same one the
 * orchestrator drives), then assembles the catalog. Tests now
 * exercise the production code path; there is one walker, one
 * test-file predicate, one source of truth for occurrence shape.
 */

import { logger } from '@opensip-tools/core';
import ts from 'typescript';

import { parseProject } from './parse.js';
import { walkProgram } from './walk.js';

import type { Catalog, FunctionOccurrence, ParseError } from '@opensip-tools/graph';

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

  const parsed = parseProject({
    projectDirAbs: input.projectDirAbs,
    files: input.files,
    compilerOptions: input.compilerOptions,
  });
  const walked = walkProgram({
    program: parsed.project.program,
    files: input.files,
    projectDirAbs: input.projectDirAbs,
  });

  // Inventory callers don't consume callSites — those flow through
  // resolveEdges* on the edge-resolution path. Drop them here.
  const functions: Record<string, FunctionOccurrence[]> = walked.functions;

  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: new Date().toISOString(),
    cacheKey: `ts-${ts.version}-${input.tsConfigPathAbs}`,
    functions,
  };

  // Combine parse-time and walk-time errors. parseErrors from
  // parseProject covers syntactic diagnostics; walked.parseErrors
  // covers per-file visitor exceptions.
  const parseErrors: ParseError[] = [...parsed.parseErrors, ...walked.parseErrors];

  const totalOccurrences = Object.values(functions).reduce((n, arr) => n + arr.length, 0);
  logger.info({
    evt: 'graph.inventory.complete',
    module: 'graph:inventory',
    files: input.files.length,
    occurrences: totalOccurrences,
    parseErrors: parseErrors.length,
  });

  return { catalog, program: parsed.project.program, parseErrors };
}
