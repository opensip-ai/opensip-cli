/**
 * `parseProject` driver that sources each file's parse from a
 * `LanguageAdapter` (ADR-0010) instead of an inline grammar-bound parser.
 * It is byte-for-byte equivalent to `createTreeSitterParseProject`'s loop —
 * same read, same `ParseError` messages, same `hasError` "record but keep the
 * partial tree" behavior, same completion log — but the per-file parse is
 * `adapter.parse(source, path)`. This is what lets the graph Python adapter
 * consume `@opensip-cli/lang-python` so there is one parser per language.
 *
 * Total over `input.files` per invariant I-7: every file either parses or
 * surfaces in `parseErrors`. The adapter's `parse` is synchronous (its grammar
 * loads at module top level), so `parseProject` stays synchronous.
 */

import { sep } from 'node:path';

import { isToolErrorLike, logger, projectRelativePath, scrubText } from '@opensip-cli/core';
import { readSourceFileGuarded, throwIfGraphAdapterAborted } from '@opensip-cli/graph';

import type { TreeSitterParsedFile, TreeSitterParsedProject } from './parse.js';
import type { LanguageAdapter } from '@opensip-cli/core';
import type { ParseInput, ParseOutput, ParseError } from '@opensip-cli/graph';
import type { ParsedFile } from '@opensip-cli/tree-sitter';

/**
 * Build a graph `parseProject` from a tree-sitter-backed `LanguageAdapter`
 * (one whose `parse` returns the `{ tree, source }` `ParsedFile` shape). The
 * adapter's `id` is the `graph:parse:<id>` log-tag suffix.
 */
export function createParseProjectFromAdapter(
  adapter: LanguageAdapter<ParsedFile>,
): (input: ParseInput) => ParseOutput<TreeSitterParsedProject> {
  const module = `graph:parse:${adapter.id}`;

  return function parseProject(input: ParseInput): ParseOutput<TreeSitterParsedProject> {
    const files = new Map<string, TreeSitterParsedFile>();
    const parseErrors: ParseError[] = [];

    for (const path of input.files) {
      const result = parseOneFile(adapter, input, path);
      if (!result.ok) {
        parseErrors.push(result.error);
        continue;
      }
      if (result.parsed.tree.rootNode.hasError) {
        parseErrors.push({
          filePath: safeProjectRelativePath(input, path),
          message: 'tree-sitter reported syntax errors; partial tree retained',
        });
      }
      files.set(path, result.parsed);
    }

    throwIfGraphAdapterAborted(input.signal, `${adapter.id} parse`);

    logger.info({
      evt: 'graph.parse.complete',
      module,
      files: files.size,
      parseErrors: parseErrors.length,
    });

    return { project: { files }, parseErrors };
  };
}

type FileParseResult =
  | { readonly ok: true; readonly parsed: ParsedFile }
  | { readonly ok: false; readonly error: ParseError };

function parseOneFile(
  adapter: LanguageAdapter<ParsedFile>,
  input: ParseInput,
  path: string,
): FileParseResult {
  const stage = `${adapter.id} parse`;
  throwIfGraphAdapterAborted(input.signal, stage);
  let source: string;
  /* v8 ignore start */
  try {
    source = readSourceFileGuarded(path);
  } catch (error) {
    if (isToolErrorLike(error)) throw error;
    return {
      ok: false,
      error: parseError(
        input,
        path,
        `read failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  /* v8 ignore stop */
  throwIfGraphAdapterAborted(input.signal, stage);
  let parsed: ParsedFile | null;
  /* v8 ignore start */
  try {
    parsed = adapter.parse(source, path);
  } catch (error) {
    if (isToolErrorLike(error)) throw error;
    return {
      ok: false,
      error: parseError(input, path, error instanceof Error ? error.message : String(error)),
    };
  }
  if (parsed === null) {
    return { ok: false, error: parseError(input, path, 'tree-sitter returned no tree') };
  }
  /* v8 ignore stop */
  throwIfGraphAdapterAborted(input.signal, stage);
  return { ok: true, parsed };
}

function parseError(input: ParseInput, path: string, message: string): ParseError {
  const filePath = safeProjectRelativePath(input, path);
  const safeMessage = scrubText(
    message.replaceAll(path, filePath).replaceAll(input.projectDirAbs, '[project]'),
    1000,
  );
  return { filePath, message: safeMessage };
}

function safeProjectRelativePath(input: ParseInput, path: string): string {
  return projectRelativePath(path.split(sep).join('/'), input.projectDirAbs.split(sep).join('/'));
}
