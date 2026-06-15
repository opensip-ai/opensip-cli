/**
 * Behavior tests for `createParseProjectFromAdapter`.
 *
 * The driver is deliberately decoupled from any one grammar: it accepts a
 * `LanguageAdapter<ParsedFile>` and only ever touches `adapter.id`,
 * `adapter.parse(source, path)`, and the returned `parsed.tree.rootNode.hasError`
 * flag. These tests drive it with a tiny fake adapter (the same `as never`
 * fake-node harness the sibling tests use) plus real temp source files, and
 * assert the real I-7 contract: every file either lands in `project.files`
 * with its source threaded through, or surfaces in `parseErrors` — and a
 * `hasError` tree is kept as a partial parse AND recorded as an error.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createParseProjectFromAdapter } from '../parse-from-adapter.js';

import type { LanguageAdapter } from '@opensip-cli/core';
import type { ParsedFile } from '@opensip-cli/tree-sitter';

// A fake parsed tree whose only observed field is `rootNode.hasError`. The
// driver also threads `source` straight through, so we keep it on the object.
const mkParsed = (source: string, hasError: boolean): ParsedFile =>
  ({ source, tree: { rootNode: { hasError } } }) as never;

/**
 * A minimal `LanguageAdapter<ParsedFile>` that records every `parse` call and
 * flags any file whose source contains `BROKEN` as `hasError`. This is enough
 * to exercise both sides of the `hasError` branch with real on-disk files.
 */
const makeFakeAdapter = (): {
  readonly adapter: LanguageAdapter<ParsedFile>;
  readonly calls: { source: string; path: string }[];
} => {
  const calls: { source: string; path: string }[] = [];
  const adapter = {
    id: 'fake',
    parse(source: string, path: string): ParsedFile {
      calls.push({ source, path });
      return mkParsed(source, source.includes('BROKEN'));
    },
  } as never as LanguageAdapter<ParsedFile>;
  return { adapter, calls };
};

describe('createParseProjectFromAdapter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gac-pfa-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses each file via the adapter, threading source through, no errors for clean files', () => {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    writeFileSync(a, 'alpha-source', 'utf8');
    writeFileSync(b, 'beta-source', 'utf8');

    const { adapter, calls } = makeFakeAdapter();
    const parseProject = createParseProjectFromAdapter(adapter);
    const out = parseProject({ projectDirAbs: dir, files: [a, b], resolutionMode: 'exact' });

    expect(out.parseErrors).toEqual([]);
    expect(out.project.files.size).toBe(2);
    // The adapter was asked to parse each file's real on-disk content.
    expect(calls).toEqual([
      { source: 'alpha-source', path: a },
      { source: 'beta-source', path: b },
    ]);
    // The parsed file holds the original source text for later body slicing.
    expect(out.project.files.get(a)?.source).toBe('alpha-source');
    expect(out.project.files.get(b)?.source).toBe('beta-source');
  });

  it('records a parseError (project-relative path) when the tree reports hasError, keeping the partial tree', () => {
    const good = join(dir, 'good.txt');
    const bad = join(dir, 'bad.txt');
    writeFileSync(good, 'fine', 'utf8');
    writeFileSync(bad, 'BROKEN tree', 'utf8');

    const { adapter } = makeFakeAdapter();
    const parseProject = createParseProjectFromAdapter(adapter);
    const out = parseProject({
      projectDirAbs: dir,
      files: [good, bad],
      resolutionMode: 'exact',
    });

    // hasError is recorded as an error...
    expect(out.parseErrors).toHaveLength(1);
    expect(out.parseErrors[0]?.filePath).toBe('bad.txt');
    expect(out.parseErrors[0]?.message).toContain('partial tree retained');
    // ...but the partial tree is still retained in the project.
    expect(out.project.files.has(bad)).toBe(true);
    expect(out.project.files.has(good)).toBe(true);
    expect(out.project.files.size).toBe(2);
  });

  it('returns an empty project for an empty file list', () => {
    const { adapter } = makeFakeAdapter();
    const parseProject = createParseProjectFromAdapter(adapter);
    const out = parseProject({ projectDirAbs: dir, files: [], resolutionMode: 'exact' });
    expect(out.project.files.size).toBe(0);
    expect(out.parseErrors).toEqual([]);
  });
});
