import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listGitVisibleFixtureFiles } from './fixture-inventory.js';

import type { SpawnOptions, SpawnResult } from './spawn.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function timedOutResult(): SpawnResult {
  return {
    durationMs: 10_000,
    exitCode: null,
    outputLimitExceeded: false,
    signal: 'SIGTERM',
    stderr: '',
    stdout: '',
    timedOut: true,
  };
}

describe('listGitVisibleFixtureFiles', () => {
  it('applies hard subprocess bounds and fails closed on a Git timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-eval-inventory-'));
    roots.push(root);
    const fixture = join(root, 'fixture');
    mkdirSync(fixture);
    let observed: SpawnOptions | undefined;

    await expect(
      listGitVisibleFixtureFiles(fixture, root, {
        spawn: (_command, _args, options) => {
          observed = options;
          return Promise.resolve(timedOutResult());
        },
      }),
    ).rejects.toThrow('Git inventory is unavailable');
    expect(observed).toMatchObject({
      cwd: realpathSync(root),
      maxOutputBytes: 2 * 1024 * 1024,
      timeoutMs: 10_000,
    });
  });

  it('returns an exact repository-root view without ignored root files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-eval-dogfood-inventory-'));
    roots.push(root);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, '.gitignore'), '.env\n', 'utf8');
    writeFileSync(join(root, '.env'), 'IGNORED_SECRET=needle\n', 'utf8');
    writeFileSync(join(root, 'src', 'index.ts'), 'export const tracked = true;\n', 'utf8');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });

    await expect(listGitVisibleFixtureFiles(root, root)).resolves.toEqual([
      { absolutePath: join(realpathSync(root), '.gitignore'), relativePath: '.gitignore' },
      {
        absolutePath: join(realpathSync(root), 'src', 'index.ts'),
        relativePath: 'src/index.ts',
      },
    ]);
  });
});
