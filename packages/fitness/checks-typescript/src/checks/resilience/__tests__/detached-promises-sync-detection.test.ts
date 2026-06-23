import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';

import { isSyncTopLevelCallable } from '../detached-promises-sync-detection.js';
import { analyzeFileForDetachedPromises } from '../detached-promises-detection.js';

function sourceFileFor(content: string, path = 'src/example.ts'): ts.SourceFile {
  return ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
}

describe('isSyncTopLevelCallable', () => {
  it('returns true for a top-level function declaration', () => {
    const sf = sourceFileFor('function recordStage() {}\nexport async function run() {}');
    expect(isSyncTopLevelCallable(sf, 'recordStage')).toBe(true);
  });

  it('returns false for async top-level functions', () => {
    const sf = sourceFileFor('async function load() {}\nexport async function run() {}');
    expect(isSyncTopLevelCallable(sf, 'load')).toBe(false);
  });

  it('returns true for const arrow initializers', () => {
    const sf = sourceFileFor('const logEnd = () => {}\nexport async function run() {}');
    expect(isSyncTopLevelCallable(sf, 'logEnd')).toBe(true);
  });
});

describe('analyzeFileForDetachedPromises — same-file sync helpers', () => {
  it('does not flag calls to same-file sync helpers inside async functions', () => {
    const content = [
      'function recordPartitionStage() {}',
      'export async function run() {',
      '  recordPartitionStage()',
      '}',
    ].join('\n');
    expect(analyzeFileForDetachedPromises(content, 'src/graph-single-run-mode.ts')).toHaveLength(0);
  });

  it('does not flag sync-prefixed module calls', () => {
    const content = [
      'export async function run() {',
      '  assertUniqueShardIds([])',
      '  logger.logEnd("done")',
      '}',
    ].join('\n');
    expect(analyzeFileForDetachedPromises(content, 'src/sharded-graph.ts')).toHaveLength(0);
  });
});