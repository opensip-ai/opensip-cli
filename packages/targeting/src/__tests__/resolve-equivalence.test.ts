import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { preResolveAllTargets, resolveTargets } from '../resolve.js';
import { TargetRegistry } from '../target-registry.js';

import type { Target } from '@opensip-cli/config';

let testDir: string;

function fixture(rel: string, content = ''): string {
  const abs = join(testDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function makeTarget(name: string, opts: Partial<Target['config']>): Target {
  return {
    config: {
      name,
      description: name,
      include: opts.include ?? [],
      exclude: opts.exclude ?? [],
      ...(opts.tags && { tags: opts.tags }),
      ...(opts.languages && { languages: opts.languages }),
      ...(opts.concerns && { concerns: opts.concerns }),
    },
  };
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-targeting-equivalence-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('resolveTargets/preResolveAllTargets equivalence', () => {
  it('returns the same ordered files for each target slice', () => {
    fixture('src/a.ts');
    fixture('src/a.test.ts');
    fixture('src/components/a.ts');
    fixture('src/components/b.ts');
    fixture('src/components/c.ts');
    fixture('src/components/.hidden.ts');
    fixture('src/generated/skip.ts');
    fixture('src/nested/value.ts');
    fixture('src/nested/.secret.ts');
    fixture('.config/tool.ts');
    fixture('.cache/skip.ts');
    fixture('lib/x.ts');
    fixture('lib/x.js');
    fixture('README.md');

    const targets = [
      makeTarget('source', {
        include: ['./src/**/*.[tj]s', 'src/components/[ab].ts'],
        exclude: ['**/*.test.ts', 'src/components/b.ts'],
      }),
      makeTarget('hidden', {
        include: ['src/**/.*.ts', './.config/**/*.ts'],
        exclude: [],
      }),
      makeTarget('library', {
        include: ['lib/**/*.ts', 'src/components/[ac].ts'],
        exclude: ['src/components/c.ts'],
      }),
    ];
    const globalExcludes = ['**/generated/**', '**/.cache/**', 'src/**/.secret.ts'];
    const registry = new TargetRegistry();
    for (const target of targets) registry.register(target);

    const preResolved = preResolveAllTargets(registry, globalExcludes, testDir);

    for (const target of targets) {
      expect(resolveTargets([target], testDir, globalExcludes)).toEqual(
        preResolved.get(target.config.name),
      );
    }
  });
});
