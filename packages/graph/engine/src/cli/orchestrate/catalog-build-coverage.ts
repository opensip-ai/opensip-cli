import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { compareCodePoint } from '@opensip-cli/contracts';
import { currentLogger, tryCatch } from '@opensip-cli/core';

import { mergeGraphDegradations } from '../../degradation.js';

import type { CatalogBuildCoverage, GraphRunDegradation, ParseError } from '../../types.js';

const MODULE_NAME = 'graph:catalog-build-coverage';

// Local-log bounds: a repo full of unparseable files must not unbound the log
// line, and a parse diagnostic that echoes source must not land verbatim.
const PARSE_DROP_FILE_CAP = 20;
const PARSE_DROP_MESSAGE_CAP = 200;

/** Single-line, length-bounded parse diagnostic — safe for a local log body. */
function boundedParseMessage(message: string): string {
  const singleLine = message.replaceAll(/\s+/gu, ' ').trim();
  return singleLine.length > PARSE_DROP_MESSAGE_CAP
    ? `${singleLine.slice(0, PARSE_DROP_MESSAGE_CAP)}…`
    : singleLine;
}

function parseErrorLogEntry(error: ParseError): string {
  const codePrefix = error.code === undefined ? '' : `[${error.code}] `;
  return `${error.filePath}: ${codePrefix}${boundedParseMessage(error.message)}`;
}

/**
 * Name every file the parser dropped, in the run log only. The persisted
 * coverage payload stays count-only (privacy-safe); this local diagnostic is
 * the sole place the dropped paths + parser messages appear.
 */
function logDroppedParseFiles(parseErrors: readonly ParseError[]): void {
  if (parseErrors.length === 0) return;
  currentLogger().warn({
    evt: 'graph.catalog.parse.dropped',
    module: MODULE_NAME,
    count: parseErrors.length,
    files: parseErrors.slice(0, PARSE_DROP_FILE_CAP).map(parseErrorLogEntry),
    overflow: Math.max(0, parseErrors.length - PARSE_DROP_FILE_CAP),
  });
}

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

/**
 * Build bounded coverage metadata without retaining parse messages or file
 * paths. Dropped parse files are named in the local run log (fail-loud) but
 * never enter the returned, persistable payload.
 */
export function catalogBuildCoverage(input: {
  readonly projectRoot: string;
  readonly files: readonly string[];
  readonly parseErrors: readonly ParseError[];
  readonly status?: CatalogBuildCoverage['status'];
  readonly degradations?: readonly GraphRunDegradation[];
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
  logDroppedParseFiles(input.parseErrors);
  const parseErrorFiles = new Set(
    input.parseErrors
      .map((error) => projectRelative(error.filePath))
      .filter((file): file is string => file !== undefined)
      .filter((file) => fileSet.has(file)),
  );
  const degradations = mergeGraphDegradations([input.degradations ?? []]);
  if (degradations.length > 0) status = 'partial';
  return {
    status,
    discoveredFiles: fileSet.size,
    parseErrorFiles: parseErrorFiles.size,
    filesIdentity: graphInputFilesIdentity(relativeFiles),
    ...(degradations.length === 0 ? {} : { degradations }),
  };
}
