import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNativeInvoker } from '../adapters/native-tools.js';

import { withFixtureCopy } from './fixture-workspace.js';
import { HarnessPrerequisiteError } from './spawn.js';

import type { AnswerFact, ResolvedStrategyStep } from '../model/task.js';

const roots: string[] = [];

function fixtureRepository(): { readonly root: string; readonly source: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-source-'));
  roots.push(root);
  const source = join(root, 'fixture');
  mkdirSync(source);
  writeFileSync(join(root, '.gitignore'), 'fixture/.env\nfixture/ignored/\n', 'utf8');
  writeFileSync(join(source, 'marker.txt'), 'tracked fixture\n', 'utf8');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return { root, source };
}

function searchStep(pattern: string): ResolvedStrategyStep {
  return {
    arguments: { pattern },
    expectedNonEmpty: false,
    extract: (payload) =>
      (payload as { matches: { path: string }[] }).matches.map((match): AnswerFact => ({
        kind: 'file',
        path: match.path,
      })),
    id: 'search-fixture',
    rationale: 'prove copied inventory',
    tool: 'contentSearch',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('withFixtureCopy', () => {
  it('copies outside the source and cleans up after success', async () => {
    const fixture = fixtureRepository();
    let copiedRoot = '';
    const value = await withFixtureCopy(
      { fixtureDirectory: fixture.source, repositoryRoot: fixture.root },
      (root) => {
        copiedRoot = root;
        expect(root).not.toBe(fixture.source);
        expect(readFileSync(join(root, 'marker.txt'), 'utf8')).toBe('tracked fixture\n');
        return Promise.resolve('ok');
      },
    );
    expect(value).toBe('ok');
    expect(existsSync(copiedRoot)).toBe(false);
  });

  it('cleans up when the callback rejects', async () => {
    const fixture = fixtureRepository();
    let copiedRoot = '';
    await expect(
      withFixtureCopy(
        { fixtureDirectory: fixture.source, repositoryRoot: fixture.root },
        (root) => {
          copiedRoot = root;
          return Promise.reject(new Error('boom'));
        },
      ),
    ).rejects.toThrow('boom');
    expect(existsSync(copiedRoot)).toBe(false);
  });

  it('preserves a primary failure when temporary cleanup also fails', async () => {
    const fixture = fixtureRepository();
    const primary = new HarnessPrerequisiteError('fixture execution failed');
    let temporaryRoot = '';

    const error = await withFixtureCopy(
      { fixtureDirectory: fixture.source, repositoryRoot: fixture.root },
      (root) => {
        temporaryRoot = join(root, '..');
        return Promise.reject(primary);
      },
      {
        removeTemporaryRoot: (path) => {
          rmSync(path, { force: true, recursive: true });
          throw new Error(`cleanup refused ${path}`);
        },
      },
    ).then(
      () => undefined,
      (error_: unknown) => error_,
    );

    expect(error).toBe(primary);
    expect(primary.message).toContain('fixture execution failed');
    expect(primary.message).toContain('Fixture cleanup also failed');
    expect(primary.message).toContain('[redacted-path]');
    expect(primary.message).not.toContain(temporaryRoot);
    expect(existsSync(temporaryRoot)).toBe(false);
  });

  it('excludes ignored fixture bytes from the executable workspace and extracted facts', async () => {
    const fixture = fixtureRepository();
    mkdirSync(join(fixture.source, 'ignored'));
    writeFileSync(join(fixture.source, '.env'), 'IGNORED_SECRET=needle\n', 'utf8');
    writeFileSync(join(fixture.source, 'ignored', 'data.log'), 'needle\n', 'utf8');

    await withFixtureCopy(
      { fixtureDirectory: fixture.source, repositoryRoot: fixture.root },
      async (root) => {
        expect(existsSync(join(root, '.env'))).toBe(false);
        expect(existsSync(join(root, 'ignored'))).toBe(false);
        const record = await createNativeInvoker(root)(searchStep('needle'));
        expect(record.facts).toEqual([]);
        expect(record.noneOutcome).toBe('empty-complete');
      },
    );
  });
});
