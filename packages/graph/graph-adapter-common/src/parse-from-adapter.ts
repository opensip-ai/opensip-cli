// @fitness-ignore-file unbounded-memory -- reads source files one at a time; per-file memory bounded by source size (tree-sitter constraint)
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

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { logger } from '@opensip-cli/core';

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
      let source: string;
      /* v8 ignore start */
      try {
        source = readFileSync(path, 'utf8');
      } catch (error) {
        parseErrors.push({
          filePath: relative(input.projectDirAbs, path),
          message: `read failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      /* v8 ignore stop */
      let parsed: ParsedFile | null;
      /* v8 ignore start */
      try {
        parsed = adapter.parse(source, path);
      } catch (error) {
        parseErrors.push({
          filePath: relative(input.projectDirAbs, path),
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      /* v8 ignore stop */
      /* v8 ignore start */
      if (parsed === null) {
        parseErrors.push({
          filePath: relative(input.projectDirAbs, path),
          message: 'tree-sitter returned no tree',
        });
        continue;
      }
      /* v8 ignore stop */
      if (parsed.tree.rootNode.hasError) {
        parseErrors.push({
          filePath: relative(input.projectDirAbs, path),
          message: 'tree-sitter reported syntax errors; partial tree retained',
        });
      }
      files.set(path, parsed);
    }

    logger.info({
      evt: 'graph.parse.complete',
      module,
      files: files.size,
      parseErrors: parseErrors.length,
    });

    return { project: { files }, parseErrors };
  };
}
