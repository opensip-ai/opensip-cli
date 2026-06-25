/**
 * @fileoverview Shared TypeScript type-checked Program service.
 *
 * The one canonical place that builds a real `ts.Program` + bound
 * `TypeChecker` over an explicit file set, so type-aware fitness checks can ask
 * the compiler for a value's ACTUAL type instead of guessing from its name.
 * Lives here (per ADR-0010, `@opensip-cli/lang-typescript` is the single TS
 * parse/AST substrate consumed by both fitness checks and the graph adapter) so
 * the dependency on the `typescript` compiler stays isolated to this package —
 * `checks-typescript` already depends on this barrel.
 *
 * This module is STATELESS: it constructs a fresh Program per call. Per-run
 * sharing/caching (build one Program per `fit` run, reused by every type-aware
 * TS check) is the consumer's responsibility (the fitness engine hoists it onto
 * a per-run scope slot) — keeping this layer a pure, testable builder.
 *
 * Cost (measured on a ~900-file first-party corpus, default V8 heap): ~1s
 * cold-start, <0.6 GB RSS (the D2 type-aware-null-safety spec's P0 benchmark).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import * as ts from 'typescript';

/** A built Program with its bound checker and a path-keyed SourceFile lookup. */
export interface TypeCheckedProgram {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** The tsconfig the Program was anchored to, or `undefined` if none was found. */
  readonly tsconfigPath: string | undefined;
  /**
   * Resolve a SourceFile by absolute path (as passed in `rootFiles`). Declared
   * as a bound property (arrow), not a method, so callers may safely destructure
   * it off the returned object.
   */
  readonly getSourceFile: (absPath: string) => ts.SourceFile | undefined;
}

/** Options for {@link createTypeCheckedProgram}: where to resolve the tsconfig. */
export interface CreateTypeCheckedProgramOptions {
  /** Directory to resolve a tsconfig from when `tsconfigPath` is not given. */
  readonly projectRoot: string;
  /** Explicit tsconfig path (absolute, or relative to `projectRoot`). */
  readonly tsconfigPath?: string;
}

/**
 * Compiler options used when no tsconfig can be found (loose JS/TS checkouts).
 * Conservative and strict-ish so types still resolve; the consumer's fail-open
 * policy (treat unresolved/`any` as non-nullable) covers the weaker signal.
 */
const FALLBACK_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  allowJs: true,
  noEmit: true,
  skipLibCheck: true,
};

/** Resolve the tsconfig to anchor the Program to, or `undefined` if none. */
function resolveTsconfigPath(projectRoot: string, explicit?: string): string | undefined {
  if (explicit !== undefined) {
    const candidate = isAbsolute(explicit) ? explicit : resolve(projectRoot, explicit);
    return existsSync(candidate) ? candidate : undefined;
  }
  return ts.findConfigFile(projectRoot, (p) => existsSync(p), 'tsconfig.json');
}

/** Load + extends-resolve a tsconfig into effective compiler options. */
function loadCompilerOptions(tsconfigPath: string): ts.CompilerOptions {
  const raw = readFileSync(tsconfigPath, 'utf8');
  const parsed = ts.parseConfigFileTextToJson(tsconfigPath, raw);
  if (parsed.error) return { ...FALLBACK_COMPILER_OPTIONS };
  const host: ts.ParseConfigHost = {
    fileExists: (p) => existsSync(p),
    readDirectory: ts.sys.readDirectory.bind(ts.sys),
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return;
      }
    },
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
  const result = ts.parseJsonConfigFileContent(
    parsed.config as object,
    host,
    dirname(tsconfigPath),
    {},
    tsconfigPath,
  );
  return result.options;
}

/**
 * Build a type-checked Program over `rootFiles` (absolute on-disk paths). The
 * binder is forced eagerly via `getTypeChecker()` — the dominant cost — so both
 * `node.parent` chains and symbol tables are populated before the caller walks.
 * The Program reads source bytes from disk itself; do NOT pre-transform input.
 */
export function createTypeCheckedProgram(
  rootFiles: readonly string[],
  opts: CreateTypeCheckedProgramOptions,
): TypeCheckedProgram {
  const tsconfigPath = resolveTsconfigPath(opts.projectRoot, opts.tsconfigPath);
  const baseOptions = tsconfigPath
    ? loadCompilerOptions(tsconfigPath)
    : { ...FALLBACK_COMPILER_OPTIONS };
  const options: ts.CompilerOptions = {
    ...baseOptions,
    // Anchor to the origin tsconfig for project-reference/rootDir resolution.
    ...(tsconfigPath ? { configFilePath: tsconfigPath } : {}),
    noEmit: true,
  };

  const program = ts.createProgram({ rootNames: [...rootFiles], options });
  // Forces the binder (parent pointers + symbol tables). See module header.
  const checker = program.getTypeChecker();

  return {
    program,
    checker,
    tsconfigPath,
    getSourceFile: (absPath) => program.getSourceFile(absPath),
  };
}

/**
 * True when `type` CONCRETELY includes `null` or `undefined`. Fail-open by
 * construction: `any`/`unknown`/error/unresolved types have no Null/Undefined
 * union member, so they return `false` — a type-aware nullability check should
 * never flag what the compiler couldn't resolve.
 */
export function isTypeNullable(type: ts.Type): boolean {
  const members = type.isUnion() ? type.types : [type];
  return members.some((m) => (m.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0);
}
