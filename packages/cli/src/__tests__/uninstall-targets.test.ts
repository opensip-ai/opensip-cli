/**
 * uninstall targets — the pure dry-run printers (`printUserModeTargets`,
 * `printProjectDefault`, `printProjectPurge`) and their `formatSize` /
 * `formatKeepLine` helpers. All take an injected `write` callback and a
 * constructed `Target[]`, so every size bucket (B/KB/MB/GB), the empty vs
 * populated delete set, the runtime-bucket annotation, and the keep-line
 * variants are reachable without touching the filesystem.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveEphemeralProjectPaths } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import {
  collectTargets,
  printProjectDefault,
  printProjectPurge,
  printUserModeTargets,
  type Target,
} from '../commands/uninstall/targets.js';

function target(over: Partial<Target>): Target {
  return {
    path: '/p/x',
    kind: 'dir',
    sizeBytes: 0,
    bucket: 'runtime',
    ...over,
  };
}

function capture(): { out: () => string; write: (s: string) => void } {
  let buf = '';
  return { out: () => buf, write: (s) => (buf += s) };
}

describe('printUserModeTargets — formatSize buckets', () => {
  it('formats bytes / KB / MB / GB and marks dir vs file', () => {
    const c = capture();
    printUserModeTargets(c.write, [
      target({
        path: '/p/tiny',
        kind: 'file',
        sizeBytes: 512,
        bucket: 'config',
      }),
      target({ path: '/p/kb', sizeBytes: 2048 }),
      target({ path: '/p/mb', sizeBytes: 5 * 1024 * 1024 }),
      target({ path: '/p/gb', sizeBytes: 3 * 1024 * 1024 * 1024 }),
    ]);
    const out = c.out();
    expect(out).toContain('512 B');
    expect(out).toContain('KB');
    expect(out).toContain('MB');
    expect(out).toContain('GB');
    expect(out).toContain('/p/tiny ('); // file → no trailing slash
    expect(out).toContain('/p/kb/'); // dir → trailing slash
  });
});

describe('printProjectDefault', () => {
  it('reports an empty delete set', () => {
    const c = capture();
    printProjectDefault(c.write, [], [], '/proj');
    expect(c.out()).toContain('Nothing to remove');
  });

  it('lists the runtime delete set and the kept authored content', () => {
    const c = capture();
    printProjectDefault(
      c.write,
      [
        target({
          path: '/proj/opensip-cli/.runtime',
          sizeBytes: 4096,
          bucket: 'runtime',
        }),
      ],
      [
        target({
          path: '/proj/opensip-cli.config.yml',
          kind: 'file',
          bucket: 'config',
        }),
        target({
          path: '/proj/opensip-cli/fit',
          bucket: 'user-content',
          displayLabel: 'fit/checks',
          fileCount: 3,
        }),
        target({
          path: '/proj/opensip-cli/notes',
          bucket: 'user-content',
          displayLabel: 'notes',
          fileCount: 1,
        }),
        target({ path: '/proj/opensip-cli/bare', bucket: 'user-content' }), // no displayLabel
      ],
      '/proj',
    );
    const out = c.out();
    expect(out).toContain('This will remove');
    expect(out).toContain('sessions database, cache, logs, baselines'); // runtime bucket note
    expect(out).toContain('opensip-cli.config.yml'); // config keep line
    expect(out).toContain('fit/checks/ (3 files)'); // plural
    expect(out).toContain('notes/ (1 file)'); // singular
    expect(out).toContain('--purge');
  });
});

describe('collectTargets', () => {
  it('includes no-init ephemeral runtime state in project default cleanup', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-uninstall-targets-'));
    const oldHome = process.env.HOME;
    process.env.HOME = join(tmp, 'home');
    try {
      const projectDir = join(tmp, 'project');
      mkdirSync(projectDir, { recursive: true });
      const ephemeralRuntime = resolveEphemeralProjectPaths(projectDir).runtimeDir;
      mkdirSync(join(ephemeralRuntime, 'logs'), { recursive: true });
      writeFileSync(join(ephemeralRuntime, 'logs', 'run.jsonl'), '{}\n', 'utf8');

      const targets = collectTargets('project', join(tmp, 'unused-user-root'), projectDir);

      expect(targets.some((entry) => entry.path === ephemeralRuntime)).toBe(true);
      expect(targets.find((entry) => entry.path === ephemeralRuntime)?.bucket).toBe('runtime');
      expect(existsSync(join(projectDir, 'opensip-cli'))).toBe(false);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('printProjectPurge', () => {
  it('warns that everything (including authored content) is removed', () => {
    const c = capture();
    printProjectPurge(
      c.write,
      [
        target({
          path: '/proj/opensip-cli',
          sizeBytes: 1024 * 1024,
          bucket: 'user-content',
        }),
      ],
      '/proj',
    );
    const out = c.out();
    expect(out).toContain('removes EVERYTHING');
    expect(out).toContain('git status');
    expect(out).toContain('MB');
  });
});
