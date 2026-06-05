/**
 * Shared test pipeline helper.
 *
 * Drives the production stage-0/1/2 TypeScript pipeline against a discovered
 * project: `parseProject` → `walkProgram` (single walk, producing both the
 * function inventory AND the call-site records) → catalog assembly →
 * `resolveEdgesFromRecords`. This is the exact path the orchestrator's adapter
 * (`index.ts:walkProjectAdapter` + `resolveCallSitesAdapter`) drives, so tests
 * exercise the real code rather than a parallel one-shot re-walk.
 */

import ts from 'typescript';

import { resolveEdgesFromRecords } from '../edges.js';
import { parseProject } from '../parse.js';
import { walkProgram } from '../walk.js';

import type { CallSiteRecord } from '../walk.js';
import type { Catalog, ParseError } from '@opensip-tools/graph';

/** Input to {@link buildCatalog}: project root, source files, and TS compiler options. */
export interface PipelineInput {
  readonly projectDirAbs: string;
  readonly files: readonly string[];
  readonly compilerOptions: ts.CompilerOptions;
  readonly tsConfigPathAbs: string;
}

/** Stage-1 output: catalog, the live TS program, the walked call sites, and parse errors. */
export interface PipelineResult {
  readonly catalog: Catalog;
  readonly program: ts.Program;
  readonly callSites: readonly CallSiteRecord[];
  readonly parseErrors: readonly ParseError[];
}

/**
 * Run the inventory pass (parse + single walk + catalog assembly). Mirrors the
 * orchestrator's `walkProjectAdapter`: one `walkProgram` call yields both the
 * function occurrences and the call-site records.
 */
export function buildCatalog(input: PipelineInput): PipelineResult {
  const parsed = parseProject({
    projectDirAbs: input.projectDirAbs,
    files: input.files,
    compilerOptions: input.compilerOptions,
    resolutionMode: 'exact',
  });
  // This helper drives the exact (semantic) pipeline only; narrow the
  // discriminated parsed-project union to the exact variant.
  if (parsed.project.kind !== 'exact') {
    throw new Error('buildCatalog: expected exact parse result');
  }
  const program = parsed.project.program;
  const walked = walkProgram({
    sourceFiles: program.getSourceFiles(),
    files: input.files,
    projectDirAbs: input.projectDirAbs,
  });

  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: new Date().toISOString(),
    cacheKey: `ts-${ts.version}-${input.tsConfigPathAbs}`,
    functions: walked.functions,
  };

  return {
    catalog,
    program,
    callSites: walked.callSites,
    parseErrors: [...parsed.parseErrors, ...walked.parseErrors],
  };
}

/**
 * Run the edge-resolution pass over a {@link buildCatalog} result — the same
 * `resolveEdgesFromRecords` entry the orchestrator's `resolveCallSitesAdapter`
 * uses. Returns the catalog with edges populated.
 */
export async function resolveCatalogEdges(result: PipelineResult, projectDirAbs: string): Promise<Catalog> {
  const resolved = await resolveEdgesFromRecords({
    catalog: result.catalog,
    program: result.program,
    projectDirAbs,
    callSites: result.callSites,
  });
  return resolved.catalog;
}
