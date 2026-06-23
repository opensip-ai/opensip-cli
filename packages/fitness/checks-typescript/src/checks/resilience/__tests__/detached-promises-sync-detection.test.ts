import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { analyzeFileForDetachedPromises } from '../detached-promises-detection.js';
import {
  isSyncCallableInScope,
  isSyncTopLevelCallable,
} from '../detached-promises-sync-detection.js';

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

describe('isSyncCallableInScope', () => {
  it('returns true for nested function declarations in an enclosing scope', () => {
    const content = [
      'export async function discover() {',
      '  function walk(dir: string): void {}',
      '  walk("/tmp")',
      '}',
    ].join('\n');
    const sf = sourceFileFor(content);
    const call = sf.statements[0];
    expect(call).toBeDefined();
    let callExpr: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'walk') {
        callExpr = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(callExpr).toBeDefined();
    expect(isSyncCallableInScope(callExpr!, sf, 'walk')).toBe(true);
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

  it('does not flag nested sync helpers inside async functions', () => {
    const content = [
      'export async function discover() {',
      '  function walk(): void {}',
      '  walk()',
      '}',
    ].join('\n');
    expect(analyzeFileForDetachedPromises(content, 'src/workspace-units.ts')).toHaveLength(0);
  });

  it('does not flag OpenTelemetry span methods inside async callbacks', () => {
    const content = [
      'export async function withSpanAsync(fn: (span: { recordException(e: unknown): void; end(): void }) => Promise<void>) {',
      '  const span = { recordException() {}, end() {} };',
      '  try {',
      '    await fn(span);',
      '  } catch (error) {',
      '    span.recordException(error);',
      '    span.end();',
      '  }',
      '}',
    ].join('\n');
    expect(analyzeFileForDetachedPromises(content, 'src/telemetry.ts')).toHaveLength(0);
  });

  it('skips tool CLI dispatch files via FILE_SKIP_PATTERNS', () => {
    const content = [
      'export async function run() {',
      '  handleGraphError("graph", new Error("x"), cli)',
      '}',
    ].join('\n');
    expect(
      analyzeFileForDetachedPromises(
        content,
        'packages/graph/engine/src/cli/list-files.ts',
      ),
    ).toHaveLength(0);
  });
});
