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

import { parseProjectFast, type TypescriptFastParsedProject } from './parse-fast.js';

import type { ParseInput, ParseOutput, ParseError } from '@opensip-cli/graph';

/** Parsed TS project (exact tier): the live tsc {@link ts.Program} instance. */
export interface TypescriptParsedProject {
  readonly program: ts.Program;
}

/**
 * The adapter-internal parsed-project shape, discriminated by tier so the
 * walk and resolve stages can branch:
 *   - exact: `{ kind: 'exact', program }` — the live `ts.Program`; the checker
 *     is constructed lazily by the resolve stage.
 *   - fast:  `{ kind: 'fast', sourceFiles }` — standalone source files, no checker.
 * The engine treats this as opaque `unknown`; only the TS adapter introspects it.
 */
export type TsParsed =
  | ({ readonly kind: 'exact' } & TypescriptParsedProject)
  | TypescriptFastParsedProject;

/**
 * Parse the project for the requested resolution tier. `fast` skips the
 * Program + checker entirely (see {@link parseProjectFast}); `exact`
 * builds the Program and lets the resolve stage construct the checker only
 * when semantic edge resolution actually needs it.
 */
export function parseProject(input: ParseInput): ParseOutput<TsParsed> {
  if (input.resolutionMode === 'fast') {
    return parseProjectFast(input);
  }
  return parseProjectExact(input);
}

/** Constructs a tsc Program for the TS source files in the input, returning parse errors if any. */
function parseProjectExact(input: ParseInput): ParseOutput<TsParsed> {
  // Anchor the program to its origin tsconfig when discovery provided
  // one. tsc reads `options.configFilePath` for project-reference and
  // rootDir resolution; synthetic-partition discovery (flat monorepos)
  // depends on each partition's program knowing its own tsconfig.
  const compilerOptions: ts.CompilerOptions = {
    ...((input.compilerOptions ?? {}) as ts.CompilerOptions),
    ...(input.configPathAbs ? { configFilePath: input.configPathAbs } : {}),
  };
  const program = ts.createProgram({
    rootNames: [...input.files],
    options: compilerOptions,
  });
  // Force the binder. getTypeChecker() binds every source file, which
  // populates BOTH the AST parent pointers the structural walk reads (a
  // Program parses with setParentNodes:false, so node.parent is otherwise
  // undefined) AND the symbol tables the exact resolver needs. Deferring it
  // saves nothing in exact mode: resolveEdgesFromRecords (edges.ts) calls
  // getTypeChecker() unconditionally, so the bind happens either way — and
  // the cached second call is a no-op. Forcing it here is what makes the
  // walk's parent chains valid. (Fast mode skips all of this and substitutes
  // createSourceFile(setParentNodes:true); see parse-fast.ts.)
  program.getTypeChecker();

  const parseErrors: ParseError[] = [];
  /* v8 ignore start */
  const seenPaths = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    const diagnostics = program.getSyntacticDiagnostics(sf);
    if (diagnostics.length === 0) continue;
    const filePath = relative(input.projectDirAbs, sf.fileName);
    if (seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);
    for (const diag of diagnostics) {
      const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
      parseErrors.push({ filePath, message });
    }
  }
  /* v8 ignore stop */

  return { project: { kind: 'exact', program }, parseErrors };
}
