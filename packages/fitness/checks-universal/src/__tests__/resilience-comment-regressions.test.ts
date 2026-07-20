import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { LanguageRegistry, RunScope, runWithScope } from '@opensip-cli/core';
import { typescriptAdapter } from '@opensip-cli/lang-typescript';
import { fitnessTestFileCache } from '@opensip-cli/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

const languages = new LanguageRegistry();
languages.register(typescriptAdapter);
const scope = new RunScope({ languages });
Object.assign(scope, { fitness: { fileCache: fitnessTestFileCache } });

let cwd: string;
let files: string[];

function fixture(relativePath: string, content: string): void {
  const filePath = join(cwd, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  files.push(filePath);
}

async function runCheck(slug: string) {
  const check = checks.find((candidate) => candidate.config.slug === slug);
  if (!check) throw new Error(`missing check: ${slug}`);
  await fitnessTestFileCache.prewarm(cwd, ['**/*']);
  return runWithScope(scope, () => check.run(cwd, { targetFiles: files }));
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'resilience-comment-regression-'));
  files = [];
});

afterEach(() => {
  fitnessTestFileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

describe('unbounded-memory bounded-collection directive', () => {
  it('honors the directive when it is in a real comment', async () => {
    fixture(
      'src/cache.ts',
      [
        'class Cache {',
        '  private entries = new Map();',
        '  // @bounded-collection -- bounded by the owning request',
        '  add(key: string, value: string) { this.entries.set(key, value); }',
        '}',
      ].join('\n'),
    );

    const result = await runCheck('unbounded-memory');
    expect(result.signals.map((signal) => signal.metadata?.type)).not.toContain(
      'unbounded-collection',
    );
  });

  it('does not honor a directive lookalike in a string', async () => {
    fixture(
      'src/cache.ts',
      [
        'class Cache {',
        '  private entries = new Map();',
        '  private note = "/* @bounded-collection */";',
        '  add(key: string, value: string) { this.entries.set(key, value); }',
        '}',
      ].join('\n'),
    );

    const result = await runCheck('unbounded-memory');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain('unbounded-collection');
  });
});

describe('transaction callback comments', () => {
  it('recognizes a callback-managed transaction after an inline comment', async () => {
    fixture('src/transaction.ts', 'db.transaction(/* managed */ async(tx) => tx.insert(record));');

    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).not.toContain(
      'uncommitted-transaction',
    );
  });

  it('recognizes a callback-managed transaction after a multiline comment', async () => {
    fixture(
      'src/transaction.ts',
      [
        'db.transaction(',
        '  /* managed by',
        '     the callback */',
        '  async(tx) => tx.insert(record),',
        ');',
      ].join('\n'),
    );

    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).not.toContain(
      'uncommitted-transaction',
    );
  });

  it('recognizes a named managed-transaction callback', async () => {
    fixture('src/transaction.ts', 'await db.transaction(work);');

    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).not.toContain(
      'uncommitted-transaction',
    );
  });

  it('recognizes callback parameters without a fixed-length syntax window', async () => {
    fixture(
      'src/transaction.ts',
      [
        'await db.transaction(async (tx = createTx()) => tx.insert(record));',
        'await db.transaction(async ({ users, organizations, permissions, auditEntries, notifications, subscriptions }: TransactionContext) => users.insert(record));',
      ].join('\n'),
    );

    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).not.toContain(
      'uncommitted-transaction',
    );
  });

  it('continues to flag a bare manual transaction call', async () => {
    fixture('src/transaction.ts', 'await db.transaction();');

    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain(
      'uncommitted-transaction',
    );
  });

  it('matches cooked SQL string and no-substitution template values', async () => {
    fixture(
      'src/transaction.ts',
      [
        'await db.query("BEGIN\\x20TRANSACTION");',
        'await db.query(`BEGIN\\u0020TRANSACTION`);',
      ].join('\n'),
    );

    const result = await runCheck('transaction-boundary-validation');
    expect(result.signals.map((signal) => signal.metadata?.type)).toContain(
      'uncommitted-transaction',
    );
  });
});
