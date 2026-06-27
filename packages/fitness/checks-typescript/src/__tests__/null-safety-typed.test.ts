import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { RunScope, runWithScope } from '@opensip-cli/core';
import { fileCache, setCurrentRecipeCheckConfig } from '@opensip-cli/fitness';
import { createTypeCheckedProgram } from '@opensip-cli/lang-typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  analyzeNullSafetyTyped,
  nullSafety,
} from '../checks/quality/data-integrity/null-safety.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opensip-nstyped-'));
});
afterEach(() => {
  fileCache.clear();
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/** A scope carrying the fitness fileCache + a fresh shared-Program cell. */
function scopeWithFitness(): RunScope {
  const scope = new RunScope();
  Object.assign(scope, {
    fitness: { fileCache, tsProgram: { value: undefined } },
  });
  return scope;
}

// One fixture exercising every decision: nullable/undefined call receivers
// (flag), non-null receiver (ok), `any` receiver (fail-open), optional chain
// (skip), and a nullable element-access receiver (flag).
const FIXTURE = [
  'function getNullable(): { x: number } | null { return null; }',
  'function getMaybe(): { y: number } | undefined { return undefined; }',
  'function getSafe(): { z: number } { return { z: 1 }; }',
  'function getAny(): any { return 1; }',
  'const arr: ({ a: number } | null)[] = [];',
  'export function f(): unknown[] {',
  '  const out: unknown[] = [];',
  '  out.push(getNullable().x);',
  '  out.push(getMaybe().y);',
  '  out.push(getSafe().z);',
  '  out.push(getAny().w);',
  '  out.push(getNullable()?.x ?? 0);',
  '  out.push(arr[0].a);',
  '  return out;',
  '}',
].join('\n');

describe('analyzeNullSafetyTyped (type-aware detector)', () => {
  it('flags only receivers whose actual type includes null/undefined', () => {
    const file = write('src/sample.ts', FIXTURE);
    const { checker, getSourceFile } = createTypeCheckedProgram([file], {
      projectRoot: dir,
    });
    const found = analyzeNullSafetyTyped(getSourceFile(file)!, checker, file).map((v) => v.match);

    expect(found).toEqual(expect.arrayContaining(['getNullable().x', 'getMaybe().y', 'arr[0].a']));
    expect(found).toHaveLength(3);
    // Non-null, `any` (fail-open), and optional-chained receivers are NOT flagged.
    expect(found).not.toContain('getSafe().z');
    expect(found).not.toContain('getAny().w');
    expect(found.some((m) => m?.includes('?.'))).toBe(false);
  });

  it('skips safe-by-construction paths (schema/DI) entirely', () => {
    const file = write('src/sample.ts', FIXTURE);
    const { checker, getSourceFile } = createTypeCheckedProgram([file], {
      projectRoot: dir,
    });
    // The filePath drives the path skip independently of the SourceFile content.
    expect(analyzeNullSafetyTyped(getSourceFile(file)!, checker, '/proj/src/schema/x.ts')).toEqual(
      [],
    );
  });

  it('honors additionalSafeBuilders as a manual escape hatch for unresolved symbols', async () => {
    const file = write('src/sample.ts', FIXTURE);
    const { checker, getSourceFile } = createTypeCheckedProgram([file], {
      projectRoot: dir,
    });
    const sf = getSourceFile(file)!;
    const scope = new RunScope();
    await runWithScope(scope, () => {
      setCurrentRecipeCheckConfig(scope, {
        'null-safety': { additionalSafeBuilders: ['getNullable('] },
      });
      const found = analyzeNullSafetyTyped(sf, checker, file).map((v) => v.match);
      expect(found).not.toContain('getNullable().x'); // suppressed by escape hatch
      expect(found).toContain('getMaybe().y'); // still flagged
      return Promise.resolve();
    });
  });
});

describe('null-safety check — analyzeAll mode selection', () => {
  it('defaults to type-aware — catches nullable-return accesses the convention misses', async () => {
    const file = write('src/svc.ts', FIXTURE);
    const scope = scopeWithFitness();
    await runWithScope(scope, async () => {
      // No typeAware config → default on.
      await fileCache.prewarm(dir, ['**/*']);
      const result = await nullSafety.run(dir, { targetFiles: [file] });
      expect(result.signals.length).toBeGreaterThanOrEqual(3);
      expect(result.signals.every((s) => s.message.includes('unsafe property access'))).toBe(true);
      // The `get*`-prefixed nullable returns are caught (convention would miss them).
      expect(result.signals.some((s) => s.message.includes("'.x'"))).toBe(true);
    });
  });

  it('falls back to the convention heuristic when typeAware is disabled', async () => {
    const file = write('src/svc.ts', FIXTURE);
    const scope = scopeWithFitness();
    await runWithScope(scope, async () => {
      setCurrentRecipeCheckConfig(scope, {
        'null-safety': { typeAware: false },
      });
      await fileCache.prewarm(dir, ['**/*']);
      const result = await nullSafety.run(dir, { targetFiles: [file] });
      // Convention trusts `get*` calls as non-null (its false-negative), so the
      // nullable-return accesses are missed; the unknown element-access receiver
      // (`arr[0]`) is still flagged.
      expect(result.signals.some((s) => s.message.includes("'.x'"))).toBe(false);
      expect(result.signals.some((s) => s.message.includes("'.a'"))).toBe(true);
    });
  });
});
