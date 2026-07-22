/**
 * @fileoverview Regression test for the drizzle-orm-migration-guardrails
 * contentFilter bug (2026-07-20 audit): the check declared
 * `contentFilter: 'strip-strings'`, which blanks the SQL text inside
 * `sql\`...\`` template literals before `analyze()` runs — defeating the
 * check's own DANGEROUS_PATTERNS on its canonical raw-SQL usage. The
 * per-pack fixture-coverage test (fixture-coverage.test.ts) does not catch
 * this because it runs checks against an empty LanguageRegistry, where
 * `applyContentFilter` silently falls back to raw content. This test
 * registers the real TS language adapter (production simulation) so the
 * content filter actually runs, matching a real CLI invocation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { LanguageRegistry, RunScope, runWithScope } from '@opensip-cli/core';
import { typescriptAdapter } from '@opensip-cli/lang-typescript';
import { fitnessTestFileCache } from '@opensip-cli/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checks } from '../index.js';

const langRegistry = new LanguageRegistry();
langRegistry.register(typescriptAdapter);
const testScope = new RunScope({ languages: langRegistry });
Object.assign(testScope, { fitness: { fileCache: fitnessTestFileCache } });

let cwd: string;
let written: string[] = [];

function fx(rel: string, content: string): string {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  written.push(abs);
  return abs;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'opensip-drizzle-regress-'));
  written = [];
});

afterEach(() => {
  fitnessTestFileCache.clear();
  rmSync(cwd, { recursive: true, force: true });
});

describe('drizzle-orm-migration-guardrails · contentFilter regression', () => {
  it('flags DROP TABLE inside a sql`` template literal under a real language adapter', async () => {
    const check = checks.find((c) => c.config.slug === 'drizzle-orm-migration-guardrails');
    if (!check) throw new Error('check not found: drizzle-orm-migration-guardrails');

    fx(
      'migrations/0001_init.ts',
      [
        "import { sql } from 'drizzle-orm'",
        '',
        'export const up = sql`DROP TABLE legacy_users`',
        '',
      ].join('\n'),
    );

    await fitnessTestFileCache.prewarm(cwd, ['**/*']);
    const result = await runWithScope(testScope, () => check.run(cwd, { targetFiles: written }));
    const findings = result.signals.filter(
      (s) => s.ruleId === 'fit:drizzle-orm-migration-guardrails',
    );

    expect(findings.length).toBeGreaterThanOrEqual(1);
  });
});
