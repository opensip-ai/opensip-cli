// @fitness-ignore-file unbounded-memory -- reads single source files for parsing; per-file memory bounded by source size
/**
 * TypeScript fast (checker-free) parse implementation.
 *
 * The exact parse (`parse.ts`) calls `ts.createProgram` and forces
 * `program.getTypeChecker()` — the single most expensive operation in a cold
 * graph build (it binds every file: parent pointers for the walk + symbol
 * tables for the resolver). Fast mode avoids both the Program and the checker.
 *
 * Fast mode needs the parent pointers but NOT the symbol table: it
 * resolves edges syntactically (name + import graph) and never calls the
 * checker. So this path skips `createProgram`/`getTypeChecker` entirely
 * and parses each file standalone via
 * `ts.createSourceFile(..., setParentNodes: true)` — `setParentNodes`
 * populates parent pointers without binding or a checker, the cheap
 * substitute for the forced `getTypeChecker()`.
 *
 * Per contract invariant I-7 (parseProject is total over `files`): every
 * file either parses into the map or surfaces a structured ParseError.
 * Standalone `createSourceFile` always returns a (possibly partial)
 * tree; syntactic problems surface via the node's internal
 * `parseDiagnostics`, which we read per file.
 */

import { readFileSync } from 'node:fs';
import { extname, relative } from 'node:path';

import ts from 'typescript';

import type { ParseInput, ParseOutput, ParseError } from '@opensip-tools/graph';

/**
 * Fast-flavored parsed project: a per-file map of standalone
 * `ts.SourceFile`s (abs path → SF), with no `ts.Program` and no type
 * checker. The `kind: 'fast'` discriminant lets the walk and resolve
 * stages branch against {@link import('./parse.js').TsParsed}.
 */
export interface TypescriptFastParsedProject {
  readonly kind: 'fast';
  /** Absolute file path → standalone source file (parent pointers set). */
  readonly sourceFiles: ReadonlyMap<string, ts.SourceFile>;
}

/** Internal TS shape: `parseDiagnostics` is an internal field on SourceFile. */
interface SourceFileWithParseDiagnostics extends ts.SourceFile {
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
}

/**
 * Parse each input file into a standalone `ts.SourceFile` with parent
 * pointers, building no Program and constructing no type checker.
 */
export function parseProjectFast(
  input: ParseInput,
): ParseOutput<TypescriptFastParsedProject> {
  const compilerOptions = (input.compilerOptions ?? {}) as ts.CompilerOptions;
  const scriptTarget = compilerOptions.target ?? ts.ScriptTarget.Latest;

  const sourceFiles = new Map<string, ts.SourceFile>();
  const parseErrors: ParseError[] = [];

  for (const fileName of input.files) {
    let text: string;
    try {
      text = readFileSync(fileName, 'utf8');
    } catch (error) {
      /* v8 ignore next */
      parseErrors.push({
        filePath: relative(input.projectDirAbs, fileName),
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const sourceFile = ts.createSourceFile(
      fileName,
      text,
      scriptTarget,
      // setParentNodes: the cheap substitute for the forced checker —
      // populates parent pointers the walk's parent-chain visitors need.
      true,
      scriptKindForFile(fileName),
    );
    sourceFiles.set(fileName, sourceFile);

    const diagnostics = (sourceFile as SourceFileWithParseDiagnostics).parseDiagnostics;
    if (diagnostics && diagnostics.length > 0) {
      const filePath = relative(input.projectDirAbs, fileName);
      for (const diag of diagnostics) {
        parseErrors.push({
          filePath,
          message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
        });
      }
    }
  }

  return { project: { kind: 'fast', sourceFiles }, parseErrors };
}

/**
 * Pick the tsc ScriptKind from the file extension so `.tsx`/`.jsx` parse
 * JSX correctly. Standalone `createSourceFile` does not infer the kind
 * from the filename, so it must be supplied explicitly.
 */
function scriptKindForFile(fileName: string): ts.ScriptKind {
  switch (extname(fileName).toLowerCase()) {
    case '.tsx': {
      return ts.ScriptKind.TSX;
    }
    case '.jsx': {
      return ts.ScriptKind.JSX;
    }
    case '.js':
    case '.cjs':
    case '.mjs': {
      return ts.ScriptKind.JS;
    }
    default: {
      // .ts, .cts, .mts and anything else the adapter admitted.
      return ts.ScriptKind.TS;
    }
  }
}
