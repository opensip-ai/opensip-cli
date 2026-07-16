import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveInsideRoot } from './workspace-paths.js';

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { force: true, recursive: true }));
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-paths-'));
  roots.push(root);
  return root;
}

describe('resolveInsideRoot', () => {
  it('accepts an in-root relative path', () => {
    const root = temporaryRoot();
    expect(resolveInsideRoot(root, 'src/index.ts')).toBe(join(root, 'src/index.ts'));
  });

  it.each(['../escape', '/absolute/path', ''])('rejects unsafe path %j', (path) => {
    const root = temporaryRoot();
    expect(() => resolveInsideRoot(root, path)).toThrow(/relative path|escapes/u);
  });

  it('rejects an in-root symlink whose target escapes the workspace', () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    mkdirSync(join(outside, 'target'));
    symlinkSync(join(outside, 'target'), join(root, 'linked'));
    expect(() => resolveInsideRoot(root, 'linked/file.ts')).toThrow(/symlink/u);
  });
});
