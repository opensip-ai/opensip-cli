/**
 * Unit tests for the in-process fixture harness (gap P0).
 *
 * Drives `runCheckOnFixture` with a real `defineCheck` that flags the literal
 * `BANNED`: clean fixture → 0 findings, violation → ≥1, multi-file fixtures
 * write siblings, and findings are filtered to the check's own ruleId.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineCheck } from '@opensip-tools/fitness';
import { afterEach, describe, expect, it } from 'vitest';

import { planCoverageCases, runCheckOnFixture } from './run-check-on-fixture.js';

import type { CoverageConfig } from './manifest.js';
import type { Check, CheckViolation } from '@opensip-tools/fitness';

const bannedCheck = defineCheck({
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'banned-token',
  description: 'flags the literal BANNED',
  tags: ['test'],
  analyze: (content: string, filePath: string): CheckViolation[] =>
    content.includes('BANNED')
      ? [{ message: 'found BANNED', severity: 'error', filePath, line: 1 }]
      : [],
});

describe('runCheckOnFixture', () => {
  it('clean fixture → zero findings', async () => {
    const run = await runCheckOnFixture(bannedCheck, {
      files: [{ path: 'fixture.ts', content: 'export const ok = 1\n' }],
    });
    expect(run.findings).toHaveLength(0);
  });

  it('violation fixture → at least one finding, all this check’s ruleId', async () => {
    const run = await runCheckOnFixture(bannedCheck, {
      files: [{ path: 'fixture.ts', content: 'export const x = "BANNED"\n' }],
    });
    expect(run.findings.length).toBeGreaterThanOrEqual(1);
    expect(run.findings.every((s) => s.ruleId === 'fit:banned-token')).toBe(true);
  });

  it('multi-file fixture: writes siblings and targets all of them', async () => {
    const run = await runCheckOnFixture(bannedCheck, {
      files: [
        { path: 'a.ts', content: 'export const a = 1\n' },
        { path: 'nested/b.ts', content: 'export const b = "BANNED"\n' },
      ],
    });
    expect(run.findings.length).toBeGreaterThanOrEqual(1);
  });

  it('targetPaths narrows which files the check sees', async () => {
    const run = await runCheckOnFixture(bannedCheck, {
      files: [
        { path: 'seen.ts', content: 'export const ok = 1\n' },
        { path: 'ignored.ts', content: 'export const x = "BANNED"\n' },
      ],
      targetPaths: ['seen.ts'],
    });
    expect(run.findings).toHaveLength(0);
  });
});

/** A check that reads only `.config` for the planner; never run here. */
function planCheck(slug: string, over: Record<string, unknown> = {}): Check {
  return {
    config: { id: slug, slug, description: '', tags: [], analysisMode: 'analyze', ...over },
  } as unknown as Check;
}

function coverageConfig(over: Partial<CoverageConfig>): CoverageConfig {
  return {
    packName: 'test',
    checks: [],
    allowlist: [],
    commandExemptions: {},
    allowNonEmptyAllowlist: true,
    ...over,
  };
}

describe('planCoverageCases', () => {
  let root: string;

  async function fixturesRoot(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'plancov-'));
    return root;
  }

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('loads clean+violation single-file fixtures for a universal check', async () => {
    const base = await fixturesRoot();
    const dir = join(base, '__fixtures__', 'u');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'clean.txt'), 'all good\n', 'utf8');
    await writeFile(join(dir, 'violation.txt'), 'BAD here\n', 'utf8');

    const cases = await planCoverageCases(
      coverageConfig({ checks: [planCheck('u', { checkScope: { languages: [], concerns: [] } })] }),
      base,
    );

    expect(cases.map((c) => c.variant).sort()).toEqual(['clean', 'violation']);
    const clean = cases.find((c) => c.variant === 'clean');
    expect(clean?.fixture?.files[0]?.content).toContain('all good');
    expect(clean?.fixture?.files[0]?.path).toBe('fixture.txt');
    expect(clean?.label).toContain('u · clean · txt');
  });

  it('a directory fixture (<slug>/<variant>/) covers all basenames at once with multiple files', async () => {
    const base = await fixturesRoot();
    const cleanDir = join(base, '__fixtures__', 'd', 'clean');
    await mkdir(join(cleanDir, 'nested'), { recursive: true });
    await writeFile(join(cleanDir, 'a.ts'), 'export const a = 1\n', 'utf8');
    await writeFile(join(cleanDir, 'nested', 'b.ts'), 'export const b = 2\n', 'utf8');

    const cases = await planCoverageCases(
      coverageConfig({
        checks: [planCheck('d', { checkScope: { languages: ['typescript'], concerns: [] } })],
      }),
      base,
    );

    const clean = cases.find((c) => c.variant === 'clean');
    expect(clean?.label).toContain('<dir>');
    expect(clean?.fixture?.files.map((f) => f.path).sort()).toEqual([
      'a.ts',
      join('nested', 'b.ts'),
    ]);
    // No violation/ dir on disk → that variant resolves to a missing single-file fixture.
    const violation = cases.find((c) => c.variant === 'violation');
    expect(violation?.fixture).toBeNull();
    expect(violation?.missingHint).toContain('missing d/violation.ts');
  });

  it('a missing fixture file yields a null fixture with an actionable hint', async () => {
    const base = await fixturesRoot();
    await mkdir(join(base, '__fixtures__', 'm'), { recursive: true }); // dir exists, no files

    const cases = await planCoverageCases(
      coverageConfig({
        checks: [planCheck('m', { checkScope: { languages: ['python'], concerns: [] } })],
      }),
      base,
    );

    expect(cases.every((c) => c.fixture === null)).toBe(true);
    expect(cases[0]?.missingHint).toContain("allowlist 'm'");
  });

  it('skips command-exempt, allowlisted, and knownUnfixturable slugs', async () => {
    const base = await fixturesRoot();
    const cases = await planCoverageCases(
      coverageConfig({
        checks: [
          planCheck('cmd', { analysisMode: 'command' }),
          planCheck('allowed', { checkScope: { languages: [], concerns: [] } }),
          planCheck('unfix', { checkScope: { languages: [], concerns: [] } }),
        ],
        commandExemptions: { cmd: 'shells out' },
        allowlist: ['allowed'],
        knownUnfixturable: { unfix: 'absolute paths' },
      }),
      base,
    );

    expect(cases).toEqual([]);
  });

  it('returns no cases when no slugs require fixtures (empty checks)', async () => {
    const base = await fixturesRoot();
    const cases = await planCoverageCases(coverageConfig({ checks: [] }), base);
    expect(cases).toEqual([]);
  });
});
