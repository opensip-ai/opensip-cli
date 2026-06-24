/**
 * Shared walk scaffolding for the tree-sitter adapters.
 *
 * The actual node traversal (`visit` / `walkFile`) is language-specific
 * and stays in each adapter. What is duplicated — and moves here — is:
 *
 *   - `record(out, occ)`            — the occurrence-sink append.
 *   - `makeFileClassifier(...)`     — the regex-parameterized
 *                                     `isTestFile` / `isGeneratedFile`
 *                                     predicates.
 *   - `runWalk({ input, walkFile })`— the `walkProject` driver skeleton:
 *                                     allocate the output sinks, filter +
 *                                     sort `input.files`, per-file
 *                                     try/catch → `ParseError`.
 *   - `synthesizeModuleInit(...)`   — the module-init `FunctionOccurrence`
 *                                     skeleton (top-level-text join →
 *                                     `digestSyntheticBody` → occurrence).
 *                                     The `qualifiedName` shape differs per
 *                                     language and is passed in.
 */

import { relative } from 'node:path';

import { withSpan } from '@opensip-cli/core';
import { nameOf, childrenOf, namedChildrenOf } from '@opensip-cli/tree-sitter';

import type { TreeSitterParsedFile, TreeSitterParsedProject } from './parse.js';
import type {
  BodyDigest,
  CallSiteRecord,
  DependencySiteRecord,
  FunctionOccurrence,
  ParseError,
  WalkInput,
  WalkOutput,
} from '@opensip-cli/graph';
import type { Node } from '@opensip-cli/tree-sitter';

// ── output helpers ────────────────────────────────────────────────

/** Append an occurrence into the by-simple-name occurrence sink. */
export function record(out: Record<string, FunctionOccurrence[]>, occ: FunctionOccurrence): void {
  const list = out[occ.simpleName];
  if (list) list.push(occ);
  else out[occ.simpleName] = [occ];
}

// ── file classification ───────────────────────────────────────────

/** Regex inputs for the shared file classifier. */
export interface FileClassifierConfig {
  /** Matches a test file by name (e.g. `*_test.go`, `*Test.java`). */
  readonly testRe: RegExp;
  /** Matches a generated / build-output path. */
  readonly generatedRe: RegExp;
  /**
   * Optional path-based test matcher (e.g. `src/test/`, `tests/`). When
   * present, a file is a test file if EITHER `testPathRe` or `testRe`
   * matches. Go omits this (the `_test.go` name convention is exact);
   * java/python/rust supply it.
   */
  readonly testPathRe?: RegExp;
}

/** The bound file-classification predicates. */
export interface FileClassifier {
  readonly isTestFile: (rel: string) => boolean;
  readonly isGeneratedFile: (rel: string) => boolean;
}

/** Builds `isTestFile` / `isGeneratedFile` bound to the given regexes. */
export function makeFileClassifier(config: FileClassifierConfig): FileClassifier {
  const { testRe, generatedRe, testPathRe } = config;
  return {
    isTestFile:
      testPathRe === undefined
        ? (rel: string): boolean => testRe.test(rel)
        : (rel: string): boolean => testPathRe.test(rel) || testRe.test(rel),
    isGeneratedFile: (rel: string): boolean => generatedRe.test(rel),
  };
}

// ── walk driver ───────────────────────────────────────────────────

/**
 * The three output accumulators a per-file walk appends into. Grouping
 * them keeps `walkFile` (and the adapter `visit` helpers that thread
 * them) under the wide-function parameter budget, and names the cohesive
 * "walk output" concept the driver allocates once per project.
 */
export interface WalkSinks {
  /** By-simple-name occurrence sink (the engine's `out` map). */
  readonly occurrences: Record<string, FunctionOccurrence[]>;
  /** Flat list of call sites discovered across the file. */
  readonly callSites: CallSiteRecord[];
  /** Flat list of dependency (import) sites discovered across the file. */
  readonly dependencySites: DependencySiteRecord[];
}

/** Inputs to the shared `walkProject` driver. */
export interface RunWalkParams<P extends TreeSitterParsedProject> {
  readonly input: WalkInput<P>;
  /**
   * The adapter's per-file walk: visits one file's AST and pushes
   * occurrences / call sites / dependency sites into the supplied sinks.
   */
  readonly walkFile: (
    absPath: string,
    file: P['files'] extends ReadonlyMap<string, infer F> ? F : never,
    projectDirAbs: string,
    sinks: WalkSinks,
  ) => void;
}

/**
 * Drives `walkProject`: allocate the output sinks, iterate
 * `input.files` (filtered to parsed files, sorted for I-1 determinism),
 * and run `walkFile` per file with a try/catch that records a
 * `ParseError` on failure.
 */
export function runWalk<P extends TreeSitterParsedProject>(params: RunWalkParams<P>): WalkOutput {
  const { input, walkFile } = params;
  const occurrences: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  const callSites: CallSiteRecord[] = [];
  const dependencySites: DependencySiteRecord[] = [];
  const parseErrors: ParseError[] = [];
  const sinks: WalkSinks = { occurrences, callSites, dependencySites };

  const sortedPaths = [...input.files].filter((p) => input.project.files.has(p)).sort();

  return withSpan(
    'opensip-cli-graph',
    'graph.walk',
    () => {
      for (const path of sortedPaths) {
        const file = input.project.files.get(path);
        if (!file) continue;
        try {
          walkFile(
            path,
            file as P['files'] extends ReadonlyMap<string, infer F> ? F : never,
            input.projectDirAbs,
            sinks,
          );
        } catch (error) {
          parseErrors.push({
            filePath: relative(input.projectDirAbs, path),
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { occurrences, callSites, dependencySites, parseErrors };
    },
    {
      'graph.walk.file_count': sortedPaths.length,
    },
  );
}

// ── module-init synthesis ─────────────────────────────────────────

/** Inputs to the shared module-init occurrence builder. */
export interface SynthesizeModuleInitParams<F extends TreeSitterParsedFile> {
  readonly file: F;
  readonly filePathProjectRel: string;
  readonly inTestFile: boolean;
  readonly definedInGenerated: boolean;
  /** The adapter's synthetic-body digest (same normalization as real bodies). */
  readonly digestSyntheticBody: (text: string) => BodyDigest;
  /**
   * The fully-built `qualifiedName` for the synthetic `<module-init>`
   * occurrence — language-specific (extension strip + separator differ:
   * `pkg/file.<module-init>` for go, `a.b.<module-init>` for python,
   * `a::b::<module-init>` for rust, …). Computed by the adapter.
   */
  readonly qualifiedName: string;
}

/**
 * Build the synthetic `<module-init>` `FunctionOccurrence`: hash the
 * file's top-level statement-text concatenation and assemble the
 * occurrence with the adapter-supplied `qualifiedName`.
 */
export function synthesizeModuleInit<F extends TreeSitterParsedFile>(
  params: SynthesizeModuleInitParams<F>,
): FunctionOccurrence {
  const {
    file,
    filePathProjectRel,
    inTestFile,
    definedInGenerated,
    digestSyntheticBody,
    qualifiedName,
  } = params;
  const root: Node = file.tree.rootNode;
  const topLevelText = childrenOf(root)
    .map((c) => file.source.slice(c.startIndex, c.endIndex))
    .join('\n');
  const digest = digestSyntheticBody(`${filePathProjectRel}\n${topLevelText}`);
  return {
    bodyHash: digest.hash,
    bodySize: digest.size,
    simpleName: `<module-init:${filePathProjectRel}>`,
    qualifiedName,
    filePath: filePathProjectRel,
    line: 1,
    column: 0,
    endLine: root.endPosition.row + 1,
    kind: 'module-init',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile,
    definedInGenerated,
    calls: [],
  };
}

// ── node helpers ──────────────────────────────────────────────────

// `nameOf` / `childrenOf` / `namedChildrenOf` now live in the canonical
// grammar-agnostic substrate `@opensip-cli/tree-sitter` (ADR-0010). They
// are re-exported here so the graph adapters' existing imports from
// `@opensip-cli/graph-adapter-common` are unchanged. (Imported, not just
// re-exported, because `synthesizeModuleInit` above uses `childrenOf`
// internally — a plain `export…from` would not bind it in scope.)
// eslint-disable-next-line unicorn/prefer-export-from -- childrenOf is also used internally; the import binding is required
export { nameOf, childrenOf, namedChildrenOf };

// ── resolver helper ───────────────────────────────────────────────

/**
 * Build a simple-name → bodyHash[] index from the walk's occurrence map.
 * Skips synthetic names (those starting with `<`); only real names are
 * resolution targets. Language-agnostic (operates on the engine's
 * `FunctionOccurrence` record), so it is shared by every resolver that
 * needs it (go / java / python; rust resolves differently).
 *
 * `keepFile` (optional) gates which occurrences are indexed by their defining
 * file path. The tree-sitter resolvers link by SIMPLE NAME against the merged
 * catalog. On the single-program (exact) build that catalog holds occurrences
 * from EVERY language, so a Go `foo()` could otherwise pin a TypeScript `foo`
 * — a cross-language false edge that the per-shard (sharded) build, whose shards
 * are single-language, never forms. Passing {@link sameLanguageFileFilter} keeps
 * resolution same-language in BOTH engines (symmetric) and is the correct call
 * graph regardless: a static name match across language boundaries is never a
 * real in-process call. Omitted ⇒ no filtering (legacy behaviour).
 */
export function buildNameIndex(
  functions: Readonly<Record<string, readonly FunctionOccurrence[]>>,
  keepFile?: (filePath: string) => boolean,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const [name, occs] of Object.entries(functions)) {
    if (!occs) continue;
    if (name.startsWith('<')) continue;
    const list: string[] = out.get(name) ?? [];
    for (const o of occs) {
      if (keepFile && !keepFile(o.filePath)) continue;
      list.push(o.bodyHash);
    }
    if (list.length > 0) out.set(name, list);
  }
  return out;
}

/**
 * Canonical file extensions per tree-sitter resolver language. Used to keep
 * name-index resolution same-language (see {@link buildNameIndex}). Matched by
 * LANGUAGE, not a single literal extension, so a language with several
 * extensions (Python `.py`/`.pyi`) is not split. Only the languages that build a
 * name index appear here; an unrecognized language disables filtering (fails
 * safe to legacy behaviour rather than dropping real edges).
 */
const LANGUAGE_FILE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  go: ['.go'],
  java: ['.java'],
  python: ['.py', '.pyi'],
  rust: ['.rs'],
};

/**
 * A predicate keeping only files written in `language` (by extension), for
 * {@link buildNameIndex}'s `keepFile`. Unknown language ⇒ keep everything.
 */
export function sameLanguageFileFilter(language: string): (filePath: string) => boolean {
  const exts = LANGUAGE_FILE_EXTENSIONS[language];
  if (exts === undefined || exts.length === 0) return () => true;
  return (filePath) => exts.some((ext) => filePath.endsWith(ext));
}
