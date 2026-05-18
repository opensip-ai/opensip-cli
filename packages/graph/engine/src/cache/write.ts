/**
 * Cache write — atomic JSON serialization of the catalog.
 *
 * Atomic via tmp + rename so a concurrent run can't observe a torn
 * write. Per §6.3.
 *
 * The body is streamed: catalog metadata is serialized via
 * `JSON.stringify` with a sentinel placeholder for the `functions`
 * field, then the prefix is written, the `functions` map is emitted
 * entry-by-entry, and the suffix follows. This keeps the write peak
 * bounded by the largest single occurrence array rather than the
 * full catalog. See docs/plans/graph-performance-improvements.md
 * Phase 2.
 */

import { closeSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

import { logger, SystemError } from '@opensip-tools/core';

import { iterateNormalizedFunctionEntries } from './normalize.js';

import type { Catalog, FunctionOccurrence } from '../types.js';

/**
 * Marker used to split the `functions` slot out of the metadata
 * serialization. JSON.stringify embeds the marker; the writer slices
 * around it. The marker is unambiguous: `JSON.stringify` always
 * emits this exact 16-byte literal for the string value, and that
 * sequence cannot appear elsewhere in the metadata (no other field
 * holds a string with `__OPENSIP_FUNCTIONS_PLACEHOLDER__`).
 */
const FUNCTIONS_PLACEHOLDER = '__OPENSIP_FUNCTIONS_PLACEHOLDER__';
const QUOTED_PLACEHOLDER = `"${FUNCTIONS_PLACEHOLDER}"`;

export function writeCatalog(catalogPath: string, catalog: Catalog): void {
  const tmpPath = `${catalogPath}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
  let fd: number | null = null;
  try {
    mkdirSync(dirname(catalogPath), { recursive: true });
    fd = openSync(tmpPath, 'w');
    writeStreamed(fd, catalog);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, catalogPath);
    logger.info({
      evt: 'graph.cache.write.complete',
      module: 'graph:cache',
      path: catalogPath,
    });
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore — original error is what we want to report
      }
    }
    logger.error({
      evt: 'graph.cache.write.error',
      module: 'graph:cache',
      path: catalogPath,
      err: error instanceof Error ? error.message : String(error),
    });
    throw new SystemError(
      `Failed to write graph catalog: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeStreamed(fd: number, catalog: Catalog): void {
  const metadata = { ...catalog, functions: FUNCTIONS_PLACEHOLDER };
  const metadataJson = JSON.stringify(metadata, null, 2);
  const placeholderIndex = metadataJson.indexOf(QUOTED_PLACEHOLDER);
  if (placeholderIndex === -1) {
    throw new SystemError('Failed to locate functions placeholder in catalog metadata.');
  }
  const prefix = metadataJson.slice(0, placeholderIndex);
  const suffix = metadataJson.slice(placeholderIndex + QUOTED_PLACEHOLDER.length);

  writeAll(fd, prefix);
  writeFunctionsMap(fd, catalog);
  writeAll(fd, suffix);
  writeAll(fd, '\n');
}

/**
 * Emit the `functions` map at JSON.stringify(_, null, 2)'s 4-space
 * inner-indent level (4 spaces because functions is itself nested
 * one level inside the top-level object).
 */
function writeFunctionsMap(fd: number, catalog: Catalog): void {
  const entryIter = iterateNormalizedFunctionEntries(catalog);
  let first = true;
  let opened = false;
  for (const [name, occurrences] of entryIter) {
    if (!opened) {
      writeAll(fd, '{');
      opened = true;
    }
    if (!first) writeAll(fd, ',');
    first = false;
    writeAll(fd, `\n    ${JSON.stringify(name)}: `);
    writeOccurrenceArray(fd, occurrences);
  }
  if (!opened) {
    writeAll(fd, '{}');
    return;
  }
  writeAll(fd, '\n  }');
}

function writeOccurrenceArray(fd: number, occurrences: readonly FunctionOccurrence[]): void {
  if (occurrences.length === 0) {
    writeAll(fd, '[]');
    return;
  }
  writeAll(fd, '[');
  let firstOccurrence = true;
  for (const occurrence of occurrences) {
    if (firstOccurrence) firstOccurrence = false;
    else writeAll(fd, ',');
    writeAll(fd, '\n');
    // Indent each occurrence to match JSON.stringify(_, null, 2) at
    // depth 3 (catalog -> functions -> array element). The nested
    // object is emitted with each line prefixed by 6 spaces.
    writeAll(fd, indentJson(JSON.stringify(occurrence, null, 2), 6));
  }
  writeAll(fd, '\n    ]');
}

function indentJson(json: string, indent: number): string {
  const pad = ' '.repeat(indent);
  // Prefix every line with `pad`, but the first line is already at
  // the right column from the array bracket — actually JSON.stringify
  // produces multi-line output where the first line has no leading
  // whitespace. We want every line, including the first, prefixed.
  return json
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n');
}

function writeAll(fd: number, chunk: string): void {
  // writeSync handles large strings internally; the fd points at our
  // temp file so partial writes are not a concern in practice.
  writeSync(fd, chunk);
}
