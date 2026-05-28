// @fitness-ignore-file error-handling-quality -- two intentional swallows: (1) the ParseConfigHost.readFile shim returns undefined when TS asks about a vanished referenced file (TS treats undefined as "skip"), and (2) realpathSync probe for symlink dedup falls through with the original path; both are marked v8-ignore as effectively unreachable on real input.
// @fitness-ignore-file unbounded-memory -- ParseConfigHost.readFile reads tsconfig.json files only; bounded by standard TS configuration shape
/**
 * Stage 0 — Discover files.
 *
 * Resolves the project's tsconfig and produces an absolute, realpath'd
 * list of source files for stage 1 to inventory.
 *
 * Stage 0 does not create a TypeScript Program — that's stage 1's job.
 * It is purely about *what files exist*.
 */

import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import { ConfigurationError, logger } from '@opensip-tools/core';
import ts from 'typescript';

import { normalizeProjectDir } from './normalize-project-dir.js';

/** Input to {@link discoverFiles}: project directory and optional tsconfig override. */
export interface DiscoveryInput {
  readonly projectDir: string;
  readonly tsConfigPath?: string;
}

/** Result of {@link discoverFiles}: resolved paths, source files, and TS compiler options. */
export interface DiscoveryOutput {
  readonly projectDirAbs: string;
  readonly tsConfigPathAbs: string;
  readonly files: readonly string[];
  readonly compilerOptions: ts.CompilerOptions;
}

/** Resolves the tsconfig for a TS project and returns the in-program source-file set. */
export function discoverFiles(input: DiscoveryInput): DiscoveryOutput {
  logger.info({
    evt: 'graph.discover.start',
    module: 'graph:discover',
    projectDir: input.projectDir,
  });

  const projectDirAbs = normalizeProjectDir(input.projectDir);
  const tsConfigPathAbs = resolveTsConfigPath(projectDirAbs, input.tsConfigPath);
  const { options, fileNames } = loadTsConfig(tsConfigPathAbs);
  const files = filterToSourceFiles(fileNames);

  logger.info({
    evt: 'graph.discover.complete',
    module: 'graph:discover',
    projectDir: projectDirAbs,
    tsConfig: tsConfigPathAbs,
    fileCount: files.length,
  });

  return {
    projectDirAbs,
    tsConfigPathAbs,
    files,
    compilerOptions: options,
  };
}

function resolveTsConfigPath(projectDirAbs: string, override?: string): string {
  let candidate: string;
  if (override === undefined) {
    candidate = resolve(projectDirAbs, 'tsconfig.json');
  } else {
    candidate = isAbsolute(override) ? override : resolve(projectDirAbs, override);
  }
  if (!existsSync(candidate)) {
    throw new ConfigurationError(`tsconfig.json not found at ${candidate}`);
  }
  /* v8 ignore start */
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
  /* v8 ignore stop */
}

function loadTsConfig(tsConfigPathAbs: string): {
  options: ts.CompilerOptions;
  fileNames: readonly string[];
} {
  const raw = readFileSync(tsConfigPathAbs, 'utf8');
  const parsed = ts.parseConfigFileTextToJson(tsConfigPathAbs, raw);
  /* v8 ignore start */
  if (parsed.error) {
    throw new ConfigurationError(
      `Failed to parse ${tsConfigPathAbs}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')}`,
    );
  }
  /* v8 ignore stop */
  const readDirectoryBound = ts.sys.readDirectory.bind(ts.sys);
  const host: ts.ParseConfigHost = {
    fileExists: (p) => existsSync(p),
    readDirectory: readDirectoryBound,
    /* v8 ignore start */
    readFile: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return;
      }
    },
    /* v8 ignore stop */
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
  const result = ts.parseJsonConfigFileContent(
    parsed.config as object,
    host,
    dirname(tsConfigPathAbs),
    {},
    tsConfigPathAbs,
  );
  /* v8 ignore start */
  if (result.errors.length > 0) {
    const fatal = result.errors.find((e) => e.category === ts.DiagnosticCategory.Error);
    if (fatal) {
      throw new ConfigurationError(
        `Failed to load ${tsConfigPathAbs}: ${ts.flattenDiagnosticMessageText(fatal.messageText, '\n')}`,
      );
    }
  }
  /* v8 ignore stop */
  return { options: result.options, fileNames: result.fileNames };
}

function filterToSourceFiles(fileNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fileNames) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
    if (f.endsWith('.d.ts')) continue;
    let real = f;
    /* v8 ignore start */
    try {
      real = realpathSync(f);
    } catch {
      // Use the original path if realpath fails (file might be in a symlinked dir).
    }
    /* v8 ignore stop */
    // Normalize separators on Windows so dedup works.
    const key = real.split(sep).join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  out.sort();
  return out;
}
