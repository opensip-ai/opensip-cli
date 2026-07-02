import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseKnipOutput } from '../checks/quality/code-structure/dead-code.js';
import { checks } from '../index.js';

function findCheck(slug: string) {
  const check = checks.find((candidate) => candidate.config.slug === slug);
  if (check === undefined) throw new Error(`check not found: ${slug}`);
  return check;
}

function writeFixture(root: string, relativePath: string, content: string): string {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
  return absolutePath;
}

describe('repair actions', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('emits replace-ts-ignore for safe TypeScript directive replacement', async () => {
    root = mkdtempSync(join(tmpdir(), 'opensip-repair-actions-'));
    const filePath = writeFixture(
      root,
      'src/example.ts',
      '// @ts-ignore -- legacy third-party type mismatch\nlegacy();\n',
    );

    const result = await findCheck('typescript-directive-hygiene').run(root, {
      targetFiles: [filePath],
    });

    expect(result.signals[0]?.repair?.actions?.[0]?.id).toBe('replace-ts-ignore');
    expect(result.signals[0]?.repair?.actions?.[0]?.autofixable).toBe(true);
  });

  it('emits advisory add-suppression-reason for missing TypeScript directive reasons', async () => {
    root = mkdtempSync(join(tmpdir(), 'opensip-repair-actions-'));
    const filePath = writeFixture(root, 'src/example.ts', '// @ts-expect-error\nlegacy();\n');

    const result = await findCheck('typescript-directive-hygiene').run(root, {
      targetFiles: [filePath],
    });

    expect(result.signals[0]?.repair?.actions?.[0]?.id).toBe('add-suppression-reason');
    expect(result.signals[0]?.repair?.actions?.[0]?.autofixable).toBe(false);
  });

  it('emits remove-unused-dependency with package section metadata', () => {
    root = mkdtempSync(join(tmpdir(), 'opensip-repair-actions-'));
    const violations = parseKnipOutput(
      JSON.stringify({
        issues: [
          {
            file: 'package.json',
            devDependencies: [{ name: 'unused-dev', line: 7 }],
          },
        ],
      }),
      root,
    );

    const action = violations[0]?.repair?.actions?.[0];

    expect(action?.id).toBe('remove-unused-dependency');
    expect(action?.target?.packageName).toBe('unused-dev');
    expect(action?.target?.dependencySection).toBe('devDependencies');
  });
});
