import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { renderBounded, TRUNCATION_MARKER, walkFiles } from './native-files.js';
import { createNativeInvoker } from './native-tools.js';

import type { WalkLimits } from './native-files.js';
import type { AnswerFact, ResolvedStrategyStep } from '../model/task.js';

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { force: true, recursive: true }));
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-native-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true });
  mkdirSync(join(root, '__fixtures__'), { recursive: true });
  mkdirSync(join(root, 'nested', '__fixtures__'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const needle = 1;\n', 'utf8');
  writeFileSync(
    join(root, 'src', 'b.ts'),
    'export function caller(): void {\n  needle();\n}\n',
    'utf8',
  );
  writeFileSync(join(root, 'node_modules', 'ignored', 'x.ts'), 'needle();\n', 'utf8');
  writeFileSync(join(root, '__fixtures__', 'direct.ts'), 'needle();\n', 'utf8');
  writeFileSync(join(root, 'nested', '__fixtures__', 'direct.ts'), 'needle();\n', 'utf8');
  return root;
}

function step(
  tool: string,
  arguments_: ResolvedStrategyStep['arguments'],
  extract: ResolvedStrategyStep['extract'] = () => [],
): ResolvedStrategyStep {
  return {
    arguments: arguments_,
    expectedNonEmpty: false,
    extract,
    id: `${tool}-step`,
    rationale: 'test',
    tool,
  };
}

function walkLimits(overrides: Partial<WalkLimits>): WalkLimits {
  return {
    maxDepth: 10,
    maxEntriesPerDirectory: 100,
    maxFiles: 100,
    maxVisitedDirectories: 100,
    maxVisitedEntries: 100,
    ...overrides,
  };
}

describe('bounded native file walk', () => {
  it('bounds empty-directory traversal by visited directory count', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-eval-native-empty-'));
    roots.push(root);
    for (const name of ['a', 'b', 'c']) mkdirSync(join(root, name));

    expect(walkFiles(root, 100, walkLimits({ maxVisitedDirectories: 2 }))).toEqual({
      paths: [],
      truncated: true,
    });
  });

  it('bounds deeply nested directory traversal without recursion', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-eval-native-deep-'));
    roots.push(root);
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });

    expect(walkFiles(root, 100, walkLimits({ maxDepth: 2 }))).toEqual({
      paths: [],
      truncated: true,
    });
  });

  it('discards an over-wide directory before its iteration order can affect results', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-eval-native-wide-'));
    roots.push(root);
    for (const name of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(root, name), '', 'utf8');

    expect(walkFiles(root, 100, walkLimits({ maxEntriesPerDirectory: 2 }))).toEqual({
      paths: [],
      truncated: true,
    });
  });
});

describe('native tools', () => {
  it('renders deterministic rg-shaped matches and excludes dependency trees', async () => {
    const invoke = createNativeInvoker(fixture());
    const record = await invoke(
      step('contentSearch', { pattern: 'needle', glob: '**/*.ts' }, (payload) => {
        const matches = (payload as { matches: { path: string }[] }).matches;
        return matches.map((match): AnswerFact => ({
          kind: 'file',
          path: match.path,
        }));
      }),
    );
    expect(record.facts).toEqual([
      { kind: 'file', path: 'src/a.ts' },
      { kind: 'file', path: 'src/b.ts' },
    ]);
    expect(record.responseBytes).toBeGreaterThan(0);
    expect(record.completeness).toBe('complete');
  });

  it('confines dogfood search, glob, and reads to an admitted Git-visible path view', async () => {
    const root = fixture();
    writeFileSync(join(root, '.env'), 'needle\n', 'utf8');
    const invoke = createNativeInvoker(root, { allowedPaths: ['src/a.ts'] });
    const search = await invoke(
      step('contentSearch', { pattern: 'needle' }, (payload) =>
        (payload as { matches: { path: string }[] }).matches.map((match): AnswerFact => ({
          kind: 'file',
          path: match.path,
        })),
      ),
    );
    const glob = await invoke(
      step('globList', { pattern: '**/*.ts' }, (payload) =>
        (payload as { paths: string[] }).paths.map((path): AnswerFact => ({ kind: 'file', path })),
      ),
    );
    const rejectedRead = await invoke(step('readFile', { path: '.env' }));

    expect(search.facts).toEqual([{ kind: 'file', path: 'src/a.ts' }]);
    expect(glob.facts).toEqual([{ kind: 'file', path: 'src/a.ts' }]);
    expect(rejectedRead.noneOutcome).toBe('failed');
    expect(rejectedRead.failure?.message).toContain('outside the admitted Git-visible file view');
  });

  it.each([
    ['maxMatches', { pattern: 'needle', maxMatches: 1 }],
    ['walk cap', { pattern: 'needle', maxWalkedFiles: 1 }],
  ] as const)('marks content search truncation for %s', async (_name, arguments_) => {
    const record = await createNativeInvoker(fixture())(step('contentSearch', arguments_));
    expect(record.truncated).toBe(true);
    expect(record.completeness).toBe('incomplete');
    expect(record.responseBytes).toBe(
      Buffer.byteLength(`src/a.ts:1:export const needle = 1;\n${TRUNCATION_MARKER}`, 'utf8'),
    );
  });

  it('returns explicitly bounded source context for competent outward tracing', async () => {
    const record = await createNativeInvoker(fixture())(
      step('contentSearch', { contextLines: 1, glob: 'src/b.ts', pattern: 'needle' }, (payload) => {
        const match = (payload as { matches: { context?: string }[] }).matches[0];
        return match?.context === undefined
          ? []
          : [{ kind: 'text', label: 'context', value: match.context }];
      }),
    );

    expect(record.facts).toEqual([
      {
        kind: 'text',
        label: 'context',
        value: 'export function caller(): void {\n  needle();\n}',
      },
    ]);
  });

  it('bounds file reads and makes truncation part of byte accounting', async () => {
    const record = await createNativeInvoker(fixture())(
      step('readFile', { path: 'src/a.ts', maxBytes: 5 }),
    );
    expect(record.truncated).toBe(true);
    expect(record.responseBytes).toBe(Buffer.byteLength(`expor\n${TRUNCATION_MARKER}`, 'utf8'));
  });

  it('does not expose facts for matches removed to make room for the truncation marker', async () => {
    const record = await createNativeInvoker(fixture())(
      step('contentSearch', { pattern: 'needle', maxTotalBytes: 50 }, (payload) =>
        (payload as { matches: { path: string }[] }).matches.map((match): AnswerFact => ({
          kind: 'file',
          path: match.path,
        })),
      ),
    );
    expect(record.truncated).toBe(true);
    expect(record.responseBytes).toBeLessThanOrEqual(50);
    expect(record.facts).toEqual([]);
  });

  it('rejects a render budget too small to disclose truncation', async () => {
    const record = await createNativeInvoker(fixture())(
      step('contentSearch', { pattern: 'needle', maxTotalBytes: 1 }),
    );

    expect(record).toMatchObject({
      failure: {
        code: 'native-tool-failure',
        message: expect.stringContaining('maxTotalBytes must be at least'),
      },
      noneOutcome: 'failed',
    });
  });

  it('fails unsupported tool names at the closed native dispatch boundary', async () => {
    const record = await createNativeInvoker(fixture())(step('unknownNativeTool', {}));
    expect(record.failure?.message).toBe('Unsupported native tool: unknownNativeTool');
  });

  it('bounds glob results and sorts them', async () => {
    const record = await createNativeInvoker(fixture())(
      step('globList', { pattern: '**/*.ts', maxResults: 1 }, (payload) =>
        (payload as { paths: string[] }).paths.map((path): AnswerFact => ({
          kind: 'file',
          path,
        })),
      ),
    );
    expect(record.facts).toEqual([{ kind: 'file', path: 'src/a.ts' }]);
    expect(record.truncated).toBe(true);
  });

  it('sorts global paths by Unicode code point across file/directory prefixes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-eval-native-order-'));
    roots.push(root);
    mkdirSync(join(root, 'a'), { recursive: true });
    writeFileSync(join(root, 'a.ts'), '', 'utf8');
    writeFileSync(join(root, 'a', 'x.ts'), '', 'utf8');
    writeFileSync(join(root, '\uE000.ts'), '', 'utf8');
    writeFileSync(join(root, '😀.ts'), '', 'utf8');

    const record = await createNativeInvoker(root)(
      step('globList', { pattern: '**/*.ts' }, (payload) =>
        (payload as { paths: string[] }).paths.map((path): AnswerFact => ({
          kind: 'file',
          path,
        })),
      ),
    );

    expect(record.facts).toEqual([
      { kind: 'file', path: 'a.ts' },
      { kind: 'file', path: 'a/x.ts' },
      { kind: 'file', path: '\uE000.ts' },
      { kind: 'file', path: '😀.ts' },
    ]);
  });

  it('turns containment and extractor failures into failed step data', async () => {
    const invoke = createNativeInvoker(fixture());
    const escaped = await invoke(step('readFile', { path: '../outside' }));
    const badExtractor = await invoke(
      step('globList', { pattern: '**/*' }, () => {
        throw new Error('bad extractor');
      }),
    );
    expect(escaped.noneOutcome).toBe('failed');
    expect(escaped.failure?.message).toMatch(/escapes/u);
    expect(badExtractor.noneOutcome).toBe('failed');
  });

  it('redacts workspace and host-temp prefixes from durable failure messages', async () => {
    const missingRoot = join(tmpdir(), 'agent-eval-secret-root');
    rmSync(missingRoot, { force: true, recursive: true });
    const missing = await createNativeInvoker(missingRoot)(step('readFile', { path: 'secret.ts' }));
    expect(missing.failure?.message).toContain('[redacted-path]');
    expect(missing.failure?.message).not.toContain(missingRoot);
    expect(missing.failure?.message).not.toContain(tmpdir());

    const root = fixture();
    const extractor = await createNativeInvoker(root)(
      step('globList', { pattern: '**/*' }, () => {
        throw new Error(`extractor leaked ${root}`);
      }),
    );
    expect(extractor.failure?.message).toContain('[redacted-path]');
    expect(extractor.failure?.message).not.toContain(root);
  });

  it('bounds extractor failure messages in durable records', async () => {
    const record = await createNativeInvoker(fixture())(
      step('globList', { pattern: '**/*' }, () => {
        throw new Error('x'.repeat(2000));
      }),
    );
    expect(Buffer.byteLength(record.failure?.message ?? '', 'utf8')).toBe(512);
  });
});

describe('native response rendering', () => {
  it('keeps the truncation marker visible without exceeding the byte budget', () => {
    const maxBytes = Buffer.byteLength(`first\n${TRUNCATION_MARKER}`, 'utf8');

    expect(renderBounded(['first', 'second'], maxBytes, true)).toEqual({
      rendered: `first\n${TRUNCATION_MARKER}`,
      retainedCount: 1,
      truncated: true,
    });
  });
});
