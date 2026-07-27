/**
 * Stage 0 — Discover files.
 *
 * Resolves the project's tsconfig and produces an absolute, realpath'd
 * list of source files for stage 1 to inventory.
 *
 * Stage 0 does not create a TypeScript Program — that's stage 1's job.
 * It is purely about *what files exist*.
 */

import { existsSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import {
  createToolError,
  isToolErrorLike,
  logger,
  normalizeFailure,
  scrubText,
} from '@opensip-cli/core';
import { graphErrorCatalog } from '@opensip-cli/graph';
import ts from 'typescript';

import { throwIfGraphAdapterAborted } from './cancellation.js';
import { normalizeProjectDir } from './normalize-project-dir.js';

const MAX_TSCONFIG_BYTES = 1_000_000;
const ABSOLUTE_PATH_FRAGMENT = /(?:[A-Za-z]:[\\/]|\/)[^\s'",;)]+/gu;
const TSCONFIG_NOT_FOUND = graphErrorCatalog.require('GRAPH.TSCONFIG.NOT_FOUND');
const TSCONFIG_INVALID = graphErrorCatalog.require('GRAPH.TSCONFIG.INVALID');
const TSCONFIG_LOAD_FAILED = graphErrorCatalog.require('GRAPH.TSCONFIG.LOAD_FAILED');

/** Input to {@link discoverFiles}: project directory and optional tsconfig override. */
export interface DiscoveryInput {
  readonly projectDir: string;
  readonly tsConfigPath?: string;
  readonly signal?: AbortSignal;
}

/** Result of {@link discoverFiles}: resolved paths, source files, and TS compiler options. */
export interface DiscoveryOutput {
  readonly projectDirAbs: string;
  readonly tsConfigPathAbs: string;
  readonly files: readonly string[];
  readonly compilerOptions: ts.CompilerOptions;
}

/** Resolves the tsconfig for a TS project and returns the in-program source-file set. */
export function discoverFiles(
  input: DiscoveryInput & { readonly diagnosticIntent?: 'normal' | 'quiet' },
): DiscoveryOutput {
  // Adapters retain no lifecycle log; callers own aggregate terminal events.
  // Local helper keeps intent optional; GraphLanguageAdapter.DiscoverInput is required.
  void input.diagnosticIntent;
  void logger;
  throwIfGraphAdapterAborted(input.signal, 'TypeScript discovery');

  const projectDirAbs = normalizeProjectDir(input.projectDir);
  const tsConfigPathAbs = resolveTsConfigPath(projectDirAbs, input.tsConfigPath);
  const { options, fileNames } = loadTsConfig(tsConfigPathAbs);
  const files = filterToSourceFiles(fileNames, input.signal);
  throwIfGraphAdapterAborted(input.signal, 'TypeScript discovery');

  return {
    projectDirAbs,
    tsConfigPathAbs,
    files,
    compilerOptions: options,
  };
}

/** @throws {ToolError} When the selected tsconfig is missing or cannot be inspected. */
function resolveTsConfigPath(projectDirAbs: string, override?: string): string {
  let candidate: string;
  if (override === undefined) {
    candidate = resolve(projectDirAbs, 'tsconfig.json');
  } else {
    candidate = isAbsolute(override) ? override : resolve(projectDirAbs, override);
  }
  if (!existsSync(candidate)) {
    throw createToolError(TSCONFIG_NOT_FOUND, 'TypeScript configuration was not found.', {
      metadata: {
        condition: override === undefined ? 'default-config-missing' : 'override-missing',
      },
    });
  }
  try {
    return realpathSync(candidate);
  } catch (error) {
    // @swallow-ok canonicalization is optional when the same lexical path remains readable
    const failure = normalizeFailure(error);
    logger.warn({
      evt: 'graph.adapter.tsconfig_realpath_degraded',
      module: 'graph:adapter-typescript',
      code: failure.code,
      errno: failure.metadata.errno,
      condition: 'config-realpath',
      msg: 'TypeScript configuration canonicalization failed; discovery will use its lexical path',
    });
    return candidate;
  }
}

/** @throws {ToolError} When the tsconfig or an extended config cannot be read or parsed. */
function loadTsConfig(tsConfigPathAbs: string): {
  options: ts.CompilerOptions;
  fileNames: readonly string[];
} {
  let raw: string;
  try {
    const stat = statSync(tsConfigPathAbs);
    if (!stat.isFile()) {
      throw createToolError(
        TSCONFIG_LOAD_FAILED,
        'TypeScript configuration is not a regular file.',
        { metadata: { condition: 'config-not-file' } },
      );
    }
    if (stat.size > MAX_TSCONFIG_BYTES) {
      throw createToolError(TSCONFIG_INVALID, 'TypeScript configuration is too large.', {
        metadata: { condition: 'config-too-large' },
      });
    }
    raw = readFileSync(tsConfigPathAbs, 'utf8');
  } catch (error) {
    throwTsconfigLoadFailure(error, 'config-read');
  }
  const parsed = ts.parseConfigFileTextToJson(tsConfigPathAbs, raw);
  if (parsed.error) {
    reportTsconfigDiagnostic(parsed.error, tsConfigPathAbs, 'config-parse');
    throw createToolError(TSCONFIG_INVALID, 'TypeScript configuration is invalid.', {
      metadata: { condition: 'config-parse', diagnosticCode: parsed.error.code },
    });
  }
  const readDirectoryBound = ts.sys.readDirectory.bind(ts.sys);
  const hostReadFailures: unknown[] = [];
  const host: ts.ParseConfigHost = {
    fileExists: (p) => existsSync(p),
    readDirectory: readDirectoryBound,
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch (error) {
        // TypeScript's host contract represents absence as undefined. Retain
        // that shape, then fail at the enclosing config boundary with evidence.
        hostReadFailures.push(error);
        return;
      }
    },
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
  let result: ts.ParsedCommandLine;
  try {
    result = ts.parseJsonConfigFileContent(
      parsed.config as object,
      host,
      dirname(tsConfigPathAbs),
      {},
      tsConfigPathAbs,
    );
  } catch (error) {
    throwTsconfigLoadFailure(error, 'config-expand');
  }
  if (hostReadFailures.length > 0) {
    throwTsconfigLoadFailure(hostReadFailures[0], 'extended-config-read');
  }
  if (result.errors.length > 0) {
    const fatal = result.errors.find((e) => e.category === ts.DiagnosticCategory.Error);
    if (fatal) {
      reportTsconfigDiagnostic(fatal, tsConfigPathAbs, 'config-expand');
      throw createToolError(TSCONFIG_INVALID, 'TypeScript configuration is invalid.', {
        metadata: { condition: 'config-expand', diagnosticCode: fatal.code },
      });
    }
    const first = result.errors[0];
    if (first !== undefined) reportTsconfigDiagnostic(first, tsConfigPathAbs, 'config-warning');
  }
  return { options: result.options, fileNames: result.fileNames };
}

/** @throws {ToolError} Always; preserves a registered cause or classifies the config failure. */
function throwTsconfigLoadFailure(error: unknown, condition: string): never {
  if (isToolErrorLike(error)) throw error;
  const failure = normalizeFailure(error);
  let definition = TSCONFIG_LOAD_FAILED;
  if (failure.code === 'CORE.SYSTEM.PERMISSION' || failure.code === 'CORE.SYSTEM.RESOURCE') {
    definition = failure.definition;
  } else if (failure.code === 'NOT_FOUND') {
    definition = TSCONFIG_NOT_FOUND;
  }
  throw createToolError(definition, 'TypeScript configuration could not be loaded.', {
    cause: error,
    metadata: {
      condition,
      ...(typeof failure.metadata.errno === 'string' ? { errno: failure.metadata.errno } : {}),
    },
  });
}

function reportTsconfigDiagnostic(
  diagnostic: ts.Diagnostic,
  tsConfigPathAbs: string,
  condition: string,
): void {
  const detail = scrubText(
    ts
      .flattenDiagnosticMessageText(diagnostic.messageText, ' ')
      .replaceAll(tsConfigPathAbs, '[tsconfig]')
      .replaceAll(dirname(tsConfigPathAbs), '[project]')
      .replaceAll(ABSOLUTE_PATH_FRAGMENT, '[path]'),
    500,
  );
  logger.warn({
    evt: 'graph.adapter.tsconfig_diagnostic',
    module: 'graph:adapter-typescript',
    code: TSCONFIG_INVALID.code,
    condition,
    diagnosticCode: diagnostic.code,
    detail,
    msg: 'TypeScript reported a configuration diagnostic',
  });
}

function filterToSourceFiles(fileNames: readonly string[], signal?: AbortSignal): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fileNames) {
    throwIfGraphAdapterAborted(signal, 'TypeScript discovery');
    if (!isSupportedSourceFile(f) || isDeclarationFile(f)) continue;
    let real = f;
    try {
      real = realpathSync(f);
    } catch (error) {
      // @swallow-ok a file admitted by tsc retains its lexical identity when optional canonicalization fails
      const failure = normalizeFailure(error);
      logger.debug({
        evt: 'graph.adapter.source_realpath_degraded',
        module: 'graph:adapter-typescript',
        code: failure.code,
        errno: failure.metadata.errno,
        condition: 'source-realpath',
        msg: 'A TypeScript source path could not be canonicalized; its lexical path is retained',
      });
    }
    // Normalize separators on Windows so dedup works.
    const key = real.split(sep).join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  out.sort();
  return out;
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

function isSupportedSourceFile(filePath: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function isDeclarationFile(filePath: string): boolean {
  return filePath.endsWith('.d.ts') || filePath.endsWith('.d.mts') || filePath.endsWith('.d.cts');
}
