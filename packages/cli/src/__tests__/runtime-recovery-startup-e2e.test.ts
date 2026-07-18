/**
 * Requires a built CLI. Proves startup recovery barriers fail visibly before
 * any cache/runtime fallback can be selected.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acquireRuntimeExclusiveLease,
  mutateRuntimePromotionJournal,
  projectCoordinationKey,
  resolveCoordinationPaths,
} from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

const CLI_DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

let priorHome: string | undefined;
let home: string;
let project: string;

function privateWrite(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

async function stagePromotionJournal(kind: 'open' | 'malformed'): Promise<void> {
  const writer = await acquireRuntimeExclusiveLease({ projectDir: project });
  try {
    if (kind === 'open') {
      await mutateRuntimePromotionJournal(writer, {
        operation: 'create',
        content: JSON.stringify({
          kind: 'init-promotion',
          version: 1,
          coordinationKey: writer.coordinationKey,
          operationId: 'startup-recovery-e2e',
          state: 'open',
        }),
      });
      return;
    }
    privateWrite(
      resolveCoordinationPaths().forProject(projectCoordinationKey(project)).promotionJournalFile,
      '{',
    );
  } finally {
    writer.release();
  }
}

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('startup runtime recovery guidance', () => {
  it.each(['open', 'malformed'] as const)(
    'blocks an ordinary run for a %s promotion journal without cache fallback',
    async (kind) => {
      priorHome = process.env.HOME;
      home = mkdtempSync(join(tmpdir(), 'opensip-recovery-startup-home-'));
      project = mkdtempSync(join(tmpdir(), 'opensip-recovery-startup-project-'));
      process.env.HOME = home;
      writeFileSync(join(project, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
      await stagePromotionJournal(kind);

      const result = spawnSync(
        process.execPath,
        [CLI_DIST, 'fit', '--json', '--check', 'no-console-log', '--cwd', project],
        {
          cwd: project,
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: home,
            XDG_CACHE_HOME: join(home, 'xdg-cache'),
            XDG_CONFIG_HOME: join(home, 'xdg-config'),
            NO_COLOR: '1',
          },
        },
      );

      expect(result.status, result.stderr).toBe(2);
      const outcome = JSON.parse(result.stdout) as {
        readonly kind: string;
        readonly status: string;
        readonly errors: readonly { readonly message: string; readonly suggestion?: string }[];
      };
      expect(outcome).toMatchObject({
        kind: 'bootstrap.error',
        status: 'error',
      });
      expect(outcome.errors[0]?.message).toContain('interrupted Init promotion requires recovery');
      expect(outcome.errors[0]?.suggestion).toContain('opensip status');
      expect(existsSync(join(home, '.opensip-cli', 'cache'))).toBe(false);
      expect(existsSync(join(project, 'opensip-cli'))).toBe(false);
    },
    30_000,
  );

  it('keeps an explicit missing-config startup failure machine-readable', () => {
    priorHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'opensip-missing-config-home-'));
    project = mkdtempSync(join(tmpdir(), 'opensip-missing-config-project-'));
    process.env.HOME = home;
    const missingConfig = join(project, 'missing opensip.yml');

    const result = spawnSync(
      process.execPath,
      [
        CLI_DIST,
        'fit',
        '--json',
        '--config',
        missingConfig,
        '--check',
        'no-console-log',
        '--cwd',
        project,
      ],
      {
        cwd: project,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          XDG_CACHE_HOME: join(home, 'xdg-cache'),
          XDG_CONFIG_HOME: join(home, 'xdg-config'),
          NO_COLOR: '1',
        },
      },
    );

    expect(result.status, result.stderr).toBe(2);
    const outcome = JSON.parse(result.stdout) as {
      readonly kind: string;
      readonly status: string;
      readonly errors: readonly { readonly message: string }[];
    };
    expect(outcome).toMatchObject({ kind: 'bootstrap.error', status: 'error' });
    expect(outcome.errors[0]?.message).toContain('missing opensip.yml');
    expect(existsSync(join(home, '.opensip-cli', 'cache'))).toBe(false);
    expect(existsSync(join(project, 'opensip-cli'))).toBe(false);
  });
});
