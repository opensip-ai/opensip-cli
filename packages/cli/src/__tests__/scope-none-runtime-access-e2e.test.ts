/**
 * Requires a built CLI. Exercises a real scope-none host command whose declared
 * resource footprint is the atomic project+user coordination lease.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const CLI_DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const staged: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  staged.push(path);
  return path;
}

function allRelativeFiles(root: string, relative = ''): string[] {
  const directory = join(root, relative);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(relative, entry.name);
    return entry.isDirectory() ? allRelativeFiles(root, child) : [child];
  });
}

afterEach(() => {
  for (const path of staged.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('scope-none composite runtime access', () => {
  it('runs a missing global uninstall without project persistence or retained readers', () => {
    const home = temp('opensip-scope-none-home-');
    const project = temp('opensip-scope-none-project-');
    const result = spawnSync(
      process.execPath,
      [
        CLI_DIST,
        '--no-cloud',
        'tools',
        'uninstall',
        'definitely-not-installed',
        '--global',
        '--json',
      ],
      {
        cwd: project,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          XDG_CACHE_HOME: join(home, 'xdg-cache'),
          XDG_CONFIG_HOME: join(home, 'xdg-config'),
          OPENSIP_NO_UPDATE: '1',
          NO_UPDATE_NOTIFIER: '1',
          NO_COLOR: '1',
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(existsSync(join(project, 'opensip-cli.config.yml'))).toBe(false);
    expect(existsSync(join(project, 'opensip-cli'))).toBe(false);
    const userFiles = allRelativeFiles(join(home, '.opensip-cli'));
    expect(userFiles.some((path) => path.includes('cache'))).toBe(false);
    expect(userFiles.some((path) => path.includes('datastore.sqlite'))).toBe(false);
    expect(userFiles.some((path) => path.includes('logs') || path.includes('reports'))).toBe(false);

    const coordinationRoot = join(home, '.opensip-cli-coordination');
    const coordinationFiles = allRelativeFiles(coordinationRoot);
    expect(
      coordinationFiles.filter((path) => path.includes('readers') || path.includes('user-readers')),
    ).toEqual([]);
    const statePath = join(coordinationRoot, 'state.json');
    if (existsSync(statePath)) {
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ writers: [] });
    }
  }, 30_000);
});
