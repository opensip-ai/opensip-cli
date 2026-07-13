import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { applyEditScript } from './edit-applier.js';

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { force: true, recursive: true }));
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-eval-edits-'));
  roots.push(root);
  return root;
}

describe('applyEditScript', () => {
  it('writes, appends, and deletes only inside the workspace', () => {
    const root = workspace();
    writeFileSync(join(root, 'delete.txt'), 'gone', 'utf8');
    const applied = applyEditScript(root, {
      operations: [
        { kind: 'write', path: 'nested/new.txt', content: 'a' },
        { kind: 'append', path: 'nested/new.txt', content: 'b' },
        { kind: 'delete', path: 'delete.txt' },
      ],
    });
    expect(applied).toEqual([
      { kind: 'write', path: 'nested/new.txt' },
      { kind: 'append', path: 'nested/new.txt' },
      { kind: 'delete', path: 'delete.txt' },
    ]);
    expect(readFileSync(join(root, 'nested/new.txt'), 'utf8')).toBe('ab');
    expect(existsSync(join(root, 'delete.txt'))).toBe(false);
  });

  it('rejects an escaping edit before touching the outside path', () => {
    const root = workspace();
    const outside = join(root, '..', 'agent-eval-outside-canary.txt');
    rmSync(outside, { force: true });
    expect(() =>
      applyEditScript(root, {
        operations: [
          {
            kind: 'write',
            path: '../agent-eval-outside-canary.txt',
            content: 'bad',
          },
        ],
      }),
    ).toThrow(/escapes/u);
    expect(existsSync(outside)).toBe(false);
  });
});
