/**
 * TypeScript parseProject implementation.
 *
 * Lifts `ts.createProgram` + the eager `getTypeChecker()` call out of
 * the orchestrator (where they used to live in cli/orchestrate.ts:
 * buildAndResolveCatalog) into the adapter, so the orchestrator no
 * longer imports `'typescript'` after PR 3 of plan
 * docs/plans/10-graph-language-pluggability.md.
 *
 * Per contract invariant I-7 (parseProject is total over `files`):
 * every file in `input.files` either parses successfully or surfaces
 * in `parseErrors`. The TypeScript compiler reports parse problems
 * via diagnostic streams rather than throwing; we surface those that
 * the program emits at the file level into a structured ParseError
 * list.
 */

import { relative } from 'node:path';

import ts from 'typescript';

import type { ParseInput, ParseOutput } from '../lang-adapter/types.js';
import type { ParseError } from '../types.js';

export interface TypescriptParsedProject {
  readonly program: ts.Program;
}

export function parseProject(input: ParseInput): ParseOutput<TypescriptParsedProject> {
  const compilerOptions = (input.compilerOptions ?? {}) as ts.CompilerOptions;
  const program = ts.createProgram({
    rootNames: [...input.files],
    options: compilerOptions,
  });
  // Force the binder so parent pointers + symbol table are populated
  // before either inventory visitors (which walk parent chains) or
  // resolvers (which call getSymbolAtLocation) need them.
  program.getTypeChecker();

  const parseErrors: ParseError[] = [];
  const seenPaths = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    const diagnostics = program.getSyntacticDiagnostics(sf);
    if (diagnostics.length === 0) continue;
    /* v8 ignore start */
    const filePath = relative(input.projectDirAbs, sf.fileName);
    if (seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);
    for (const diag of diagnostics) {
      const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
      parseErrors.push({ filePath, message });
    }
    /* v8 ignore stop */
  }

  return { project: { program }, parseErrors };
}
