import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasRuntimeSelector, hasSelector } from '../propagated-options.js';
import { resolveSuiteScope } from '../suite-scope.js';

let tmp: string;

function git(args: readonly string[], cwd = tmp): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function write(relative: string, content: string): void {
  const path = join(tmp, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function makeGitFixture(): void {
  git(['init', '-q']);
  git(['config', 'user.email', 'suite-scope@example.test']);
  git(['config', 'user.name', 'Suite Scope Test']);
  write('src/a.ts', 'export const a = 1;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  write('src/b.ts', 'export const b = 1;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'second']);
  write('src/a.ts', 'export const a = 2;\n');
  write('src/c.ts', 'export const c = 1;\n');
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'suite-scope-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveSuiteScope', () => {
  it('resolves decision order for full, explicit selectors, and the built-in default', () => {
    makeGitFixture();

    expect(
      resolveSuiteScope({
        cwd: tmp,
        suiteOpts: { full: true },
        defaultChanged: true,
      }),
    ).toEqual({ mode: 'full', source: 'explicit' });

    expect(
      resolveSuiteScope({
        cwd: tmp,
        suiteOpts: { changed: true },
        defaultChanged: false,
      }),
    ).toEqual({ mode: 'changed', source: 'explicit', changedFiles: 2 });

    expect(
      resolveSuiteScope({
        cwd: tmp,
        suiteOpts: { files: ['src/a.ts', 'src/c.ts'] },
        defaultChanged: false,
      }),
    ).toEqual({ mode: 'changed', source: 'explicit', changedFiles: 2 });

    expect(
      resolveSuiteScope({
        cwd: tmp,
        suiteOpts: { since: 'HEAD~1', files: ['src/a.ts'] },
        defaultChanged: false,
      }),
    ).toEqual({ mode: 'changed', source: 'explicit', changedFiles: 1 });

    expect(
      resolveSuiteScope({
        cwd: tmp,
        suiteOpts: { since: 'HEAD~1' },
        defaultChanged: false,
      }),
    ).toEqual({ mode: 'changed', source: 'explicit', ref: 'HEAD~1', changedFiles: 1 });

    expect(
      resolveSuiteScope({
        cwd: tmp,
        suiteOpts: {},
        defaultChanged: true,
      }),
    ).toEqual({ mode: 'changed', source: 'default', changedFiles: 2 });

    expect(
      resolveSuiteScope({
        cwd: tmp,
        suiteOpts: {},
        defaultChanged: false,
      }),
    ).toEqual({ mode: 'full', source: 'default' });
  });

  it('falls back to full scope for the changed default outside git', () => {
    const scope = resolveSuiteScope({
      cwd: tmp,
      suiteOpts: {},
      defaultChanged: true,
    });

    expect(scope).toMatchObject({ mode: 'full', source: 'fallback' });
    expect(scope.notice).toMatch(/running the full scope/);
  });

  it('keeps explicit selectors changed-scoped when git resolution degrades', () => {
    expect(
      resolveSuiteScope({
        cwd: tmp,
        suiteOpts: { changed: true },
        defaultChanged: true,
      }),
    ).toEqual({ mode: 'changed', source: 'explicit' });
  });

  it('treats hostile refs as structured enrichment failures without throwing', () => {
    makeGitFixture();

    expect(
      resolveSuiteScope({
        cwd: tmp,
        suiteOpts: { since: '-upload-pack=x' },
        defaultChanged: false,
      }),
    ).toEqual({ mode: 'changed', source: 'explicit', ref: '-upload-pack=x' });
  });
});

describe('hasSelector', () => {
  it('recognizes suite selectors without treating --full as a selector', () => {
    expect(hasSelector({ changed: true })).toBe(true);
    expect(hasSelector({ since: 'main' })).toBe(true);
    expect(hasSelector({ files: ['src/a.ts'] })).toBe(true);
    expect(hasSelector({})).toBe(false);
    expect(hasSelector({ full: true })).toBe(false);
    expect(hasRuntimeSelector({ full: true, changed: true })).toBe(false);
  });
});
