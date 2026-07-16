import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { compareCodePoint } from '@opensip-cli/contracts';
import { tryCatch } from '@opensip-cli/core';

import type { CatalogBuildCoverage, ParseError } from '../../types.js';

/** @throws {Error} When a build input cannot be represented as a safe project-relative path. */
function safeRelativePath(value: string): string {
  const normalized = value.split(sep).join('/').replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split('/').some((part) => part.length === 0 || part === '.' || part === '..') ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw new Error('Graph build input path is not project-relative');
  }
  return normalized;
}

/** Privacy-safe exact identity of an already-normalized project-relative file set. */
export function graphInputFilesIdentity(files: readonly string[]): string {
  const normalized = [...new Set(files.map(safeRelativePath))].sort(compareCodePoint);
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex')}`;
}

/** Build bounded coverage metadata without retaining parse messages or file paths. */
export function catalogBuildCoverage(input: {
  readonly projectRoot: string;
  readonly files: readonly string[];
  readonly parseErrors: readonly ParseError[];
  readonly status?: CatalogBuildCoverage['status'];
}): CatalogBuildCoverage {
  let status = input.status ?? 'complete';
  let canonicalRoot = resolve(input.projectRoot);
  const canonicalRootRead = tryCatch(() => realpathSync(input.projectRoot));
  if (canonicalRootRead.ok) {
    canonicalRoot = canonicalRootRead.value;
  } else {
    // Coverage metadata must never turn an otherwise reportable graph failure
    // into a second failure. Retain a deterministic lexical projection and
    // make the incomplete root evidence explicit instead.
    status = 'partial';
  }
  const projectRelative = (file: string): string | undefined => {
    if (!isAbsolute(file)) {
      const relativePath = tryCatch(() => safeRelativePath(file));
      if (relativePath.ok) return relativePath.value;
      status = 'partial';
      return;
    }
    for (const root of new Set([input.projectRoot, canonicalRoot])) {
      const relativePath = tryCatch(() => safeRelativePath(relative(root, file)));
      if (relativePath.ok) return relativePath.value;
    }
    status = 'partial';
  };
  const relativeFiles = input.files
    .map(projectRelative)
    .filter((file): file is string => file !== undefined);
  const fileSet = new Set(relativeFiles);
  const parseErrorFiles = new Set(
    input.parseErrors
      .map((error) => projectRelative(error.filePath))
      .filter((file): file is string => file !== undefined)
      .filter((file) => fileSet.has(file)),
  );
  return {
    status,
    discoveredFiles: fileSet.size,
    parseErrorFiles: parseErrorFiles.size,
    filesIdentity: graphInputFilesIdentity(relativeFiles),
  };
}
