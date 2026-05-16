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

export interface DiscoveryInput {
  readonly projectDir: string;
  readonly tsConfigPath?: string;
}

export interface DiscoveryOutput {
  readonly projectDirAbs: string;
  readonly tsConfigPathAbs: string;
  readonly files: readonly string[];
  readonly compilerOptions: ts.CompilerOptions;
}

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
  try {
    return realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function loadTsConfig(tsConfigPathAbs: string): {
  options: ts.CompilerOptions;
  fileNames: readonly string[];
} {
  const raw = readFileSync(tsConfigPathAbs, 'utf8');
  const parsed = ts.parseConfigFileTextToJson(tsConfigPathAbs, raw);
  if (parsed.error) {
    throw new ConfigurationError(
      `Failed to parse ${tsConfigPathAbs}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')}`,
    );
  }
  const readDirectoryBound = ts.sys.readDirectory.bind(ts.sys);
  const host: ts.ParseConfigHost = {
    fileExists: (p) => existsSync(p),
    readDirectory: readDirectoryBound,
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
    dirname(tsConfigPathAbs),
    {},
    tsConfigPathAbs,
  );
  if (result.errors.length > 0) {
    const fatal = result.errors.find((e) => e.category === ts.DiagnosticCategory.Error);
    if (fatal) {
      throw new ConfigurationError(
        `Failed to load ${tsConfigPathAbs}: ${ts.flattenDiagnosticMessageText(fatal.messageText, '\n')}`,
      );
    }
  }
  return { options: result.options, fileNames: result.fileNames };
}

function filterToSourceFiles(fileNames: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fileNames) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
    if (f.endsWith('.d.ts')) continue;
    let real = f;
    try {
      real = realpathSync(f);
    } catch {
      // Use the original path if realpath fails (file might be in a symlinked dir).
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
