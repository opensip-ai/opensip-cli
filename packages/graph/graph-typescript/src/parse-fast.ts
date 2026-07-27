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

import { extname, sep } from 'node:path';

import {
  isToolErrorLike,
  normalizeFailure,
  projectRelativePath,
  scrubText,
} from '@opensip-cli/core';
import { readSourceFileGuarded } from '@opensip-cli/graph';
import ts from 'typescript';

import { throwIfGraphAdapterAborted } from './cancellation.js';

import type { ParseInput, ParseOutput, ParseError } from '@opensip-cli/graph';

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

const MAX_PARSE_DIAGNOSTICS_PER_FILE = 20;
const MAX_PARSE_DIAGNOSTIC_LENGTH = 1000;

/**
 * Parse each input file into a standalone `ts.SourceFile` with parent
 * pointers, building no Program and constructing no type checker.
 */
export function parseProjectFast(input: ParseInput): ParseOutput<TypescriptFastParsedProject> {
  const compilerOptions = (input.compilerOptions ?? {}) as ts.CompilerOptions;
  const scriptTarget = compilerOptions.target ?? ts.ScriptTarget.Latest;

  const sourceFiles = new Map<string, ts.SourceFile>();
  const parseErrors: ParseError[] = [];

  for (const fileName of input.files) {
    throwIfGraphAdapterAborted(input.signal, 'TypeScript fast parse');
    let text: string;
    try {
      text = readSourceFileGuarded(fileName);
    } catch (error) {
      if (isToolErrorLike(error)) throw error;
      parseErrors.push({
        filePath: safeProjectRelativePath(input, fileName),
        message: sourceReadFailureMessage(error),
        code: 'GRAPH.TS.SOURCE_UNREADABLE',
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
    throwIfGraphAdapterAborted(input.signal, 'TypeScript fast parse');

    const diagnostics = (sourceFile as SourceFileWithParseDiagnostics).parseDiagnostics;
    if (diagnostics && diagnostics.length > 0) {
      const filePath = safeProjectRelativePath(input, fileName);
      for (const diag of diagnostics.slice(0, MAX_PARSE_DIAGNOSTICS_PER_FILE)) {
        parseErrors.push({
          filePath,
          message: scrubText(
            ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
            MAX_PARSE_DIAGNOSTIC_LENGTH,
          ),
        });
      }
      const overflow = diagnostics.length - MAX_PARSE_DIAGNOSTICS_PER_FILE;
      if (overflow > 0) {
        parseErrors.push({
          filePath,
          message: `${String(overflow)} additional TypeScript parse diagnostic(s) omitted`,
        });
      }
    }
  }

  throwIfGraphAdapterAborted(input.signal, 'TypeScript fast parse');

  return { project: { kind: 'fast', sourceFiles }, parseErrors };
}

function safeProjectRelativePath(input: ParseInput, fileName: string): string {
  return projectRelativePath(
    fileName.split(sep).join('/'),
    input.projectDirAbs.split(sep).join('/'),
  );
}

function sourceReadFailureMessage(error: unknown): string {
  const failure = normalizeFailure(error);
  if (failure.code === 'CORE.SYSTEM.PERMISSION') {
    return 'Source file could not be read because filesystem permission was denied.';
  }
  if (failure.code === 'CORE.SYSTEM.RESOURCE') {
    return 'Source file could not be read because a system resource limit was reached.';
  }
  if (failure.code === 'NOT_FOUND') {
    return 'Source file was unavailable when graph parsing began.';
  }
  if (error instanceof Error && error.message.includes('source file exceeds')) {
    return 'Source file exceeds the graph source-size limit.';
  }
  return 'Source file could not be read.';
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
