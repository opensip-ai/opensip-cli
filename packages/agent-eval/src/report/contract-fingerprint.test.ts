import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { taskRegistry } from '../tasks/index.js';

import { contractFingerprint } from './contract-fingerprint.js';

import type { GoldTask } from '../model/task.js';

const roots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-contract-'));
  roots.push(root);
  mkdirSync(join(root, 'fixture-a', 'src'), { recursive: true });
  writeFileSync(join(root, 'fixture-a', 'src', 'index.ts'), 'export const answer = 42;\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

function task(id: string, question = 'Find the answer.'): GoldTask {
  return {
    assertions: { mustInclude: [{ kind: 'count', label: 'answer', value: 42 }] },
    fixture: 'fixture-a',
    id,
    question,
    strategies: {
      control: { arm: 'control', steps: [], version: 'control-v1' },
      opensip: { arm: 'opensip', steps: [], version: 'opensip-v1' },
    },
    tags: ['contract'],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('contractFingerprint', () => {
  it('is order-independent for one selected task set', async () => {
    const root = fixtureRoot();
    const first = task('a');
    const second = task('b');

    await expect(contractFingerprint([first, second], { fixturesRoot: root })).resolves.toBe(
      await contractFingerprint([second, first], { fixturesRoot: root }),
    );
  });

  it('changes when authored truth or committed fixture bytes change', async () => {
    const root = fixtureRoot();
    const baseline = await contractFingerprint([task('a')], { fixturesRoot: root });
    const changedQuestion = await contractFingerprint([task('a', 'Find a different answer.')], {
      fixturesRoot: root,
    });
    writeFileSync(join(root, 'fixture-a', 'src', 'index.ts'), 'export const answer = 43;\n');
    const changedFixture = await contractFingerprint([task('a')], { fixturesRoot: root });

    expect(changedQuestion).not.toBe(baseline);
    expect(changedFixture).not.toBe(baseline);
  });

  it('excludes strategies because their versions are recorded per arm', async () => {
    const root = fixtureRoot();
    const baseline = task('a');
    const changedStrategy: GoldTask = {
      ...baseline,
      strategies: {
        ...baseline.strategies,
        opensip: { arm: 'opensip', steps: [], version: 'opensip-v99' },
      },
    };

    await expect(contractFingerprint([changedStrategy], { fixturesRoot: root })).resolves.toBe(
      await contractFingerprint([baseline], { fixturesRoot: root }),
    );
  });

  it('ignores Git-ignored fixture children while retaining visible source bytes', async () => {
    const root = fixtureRoot();
    const baseline = await contractFingerprint([task('a')], { fixturesRoot: root });
    mkdirSync(join(root, 'fixture-a', 'node_modules', 'dependency'), { recursive: true });
    writeFileSync(join(root, 'fixture-a', 'node_modules', 'dependency', 'index.js'), 'noise\n');
    const withIgnoredInstall = await contractFingerprint([task('a')], { fixturesRoot: root });
    writeFileSync(join(root, 'fixture-a', 'visible.ts'), 'export const visible = true;\n');
    const withVisibleSource = await contractFingerprint([task('a')], { fixturesRoot: root });

    expect(withIgnoredInstall).toBe(baseline);
    expect(withVisibleSource).not.toBe(baseline);
  });

  it('binds dogfood truth to task data while the report git SHA identifies source', async () => {
    const dogfood = { ...task('dogfood'), fixture: 'dogfood' };

    await expect(contractFingerprint([dogfood])).resolves.toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('fingerprints the complete registered catalog within separate identity/inventory bounds', async () => {
    const tasks = Object.values(taskRegistry);
    expect(new Set(tasks.map(({ fixture }) => fixture))).toEqual(
      new Set([
        'customer-py',
        'customer-staleness',
        'customer-ts',
        'customer-workspace',
        'dogfood',
      ]),
    );

    await expect(contractFingerprint(tasks)).resolves.toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('rejects a selected fixture root that is itself a symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-eval-contract-link-'));
    roots.push(root);
    const outside = mkdtempSync(join(tmpdir(), 'agent-eval-contract-outside-'));
    roots.push(outside);
    writeFileSync(join(outside, 'secret.ts'), 'export const secret = true;\n');
    symlinkSync(outside, join(root, 'fixture-a'), 'dir');

    await expect(contractFingerprint([task('a')], { fixturesRoot: root })).rejects.toThrow(
      /fixture roots may not be symlinks/u,
    );
  });

  it('rejects an oversized fixture file without accepting it into the digest', async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, 'fixture-a', 'oversized.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));

    await expect(contractFingerprint([task('a')], { fixturesRoot: root })).rejects.toThrow(
      /fixture file exceeds bounds: oversized\.bin/u,
    );
  });
});
