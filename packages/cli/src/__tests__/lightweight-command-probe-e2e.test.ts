/**
 * Requires a built CLI. Verifies trusted host/bundled Commander bailouts run
 * without runtime coordination or mutable Tool discovery.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function stageIncompatibleAuthoredTool(home: string): void {
  const toolDir = join(home, '.opensip-cli', 'tools', 'bailout-discovery-trap');
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(
    join(toolDir, 'opensip-tool.manifest.json'),
    JSON.stringify({
      kind: 'tool',
      id: 'bailout-discovery-trap',
      identity: { name: 'bailout-discovery-trap' },
      name: 'Bailout discovery trap',
      version: '1.0.0',
      apiVersion: 999,
      main: './index.js',
      commands: [{ name: 'bailout-discovery-trap', description: 'trap' }],
    }),
    'utf8',
  );
}

afterEach(() => {
  for (const path of staged.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('lightweight trusted command probe', () => {
  it.each([
    { label: 'root help', argv: ['--help'], exitCode: 0 },
    { label: 'root version', argv: ['--version'], exitCode: 0 },
    { label: 'bundled tool help', argv: ['fit', '--help'], exitCode: 0 },
    { label: 'bundled tool version', argv: ['fit', '--version'], exitCode: 0 },
    { label: 'init help', argv: ['init', '--help'], exitCode: 0 },
    { label: 'uninstall help', argv: ['uninstall', '--help'], exitCode: 0 },
    {
      label: 'known invalid choice',
      argv: ['graph', '--resolution', 'invalid-resolution'],
      exitCode: 2,
    },
    {
      label: 'known unknown option',
      argv: ['fit', '--definitely-invalid'],
      exitCode: 1,
    },
    {
      label: 'init unknown option',
      argv: ['init', '--definitely-invalid'],
      exitCode: 1,
    },
    {
      label: 'root unknown option',
      argv: ['--definitely-invalid'],
      exitCode: 1,
    },
    {
      label: 'root help before an unknown operand',
      argv: ['--help', 'totally-unknown'],
      exitCode: 0,
    },
    {
      label: 'short root help before an unknown operand',
      argv: ['-h', 'totally-unknown'],
      exitCode: 0,
    },
    {
      label: 'invalid root option before an unknown operand',
      argv: ['--definitely-invalid', 'totally-unknown'],
      exitCode: 1,
    },
  ])(
    '$label creates no runtime state',
    ({ argv, exitCode }) => {
      const home = temp('opensip-lightweight-probe-home-');
      const project = temp('opensip-lightweight-probe-project-');
      stageIncompatibleAuthoredTool(home);
      const result = spawnSync(process.execPath, [CLI_DIST, ...argv], {
        cwd: project,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          XDG_CACHE_HOME: join(home, 'xdg-cache'),
          XDG_CONFIG_HOME: join(home, 'xdg-config'),
          NO_COLOR: '1',
        },
      });

      expect(result.status, result.stderr).toBe(exitCode);
      expect(existsSync(join(home, '.opensip-cli-coordination'))).toBe(false);
      expect(existsSync(join(home, '.opensip-cli', 'cache'))).toBe(false);
      expect(existsSync(join(home, '.opensip-cli', 'update-state.json'))).toBe(false);
      expect(existsSync(join(project, 'opensip-cli'))).toBe(false);
    },
    30_000,
  );

  it.each([
    ['external command help', ['bailout-discovery-trap', '--help']],
    ['external command version', ['bailout-discovery-trap', '--version']],
    ['external help target', ['help', 'bailout-discovery-trap']],
  ] as const)('$0 falls through to protected Tool discovery', (_label, argv) => {
    const home = temp('opensip-lightweight-probe-home-');
    const project = temp('opensip-lightweight-probe-project-');
    stageIncompatibleAuthoredTool(home);
    const result = spawnSync(process.execPath, [CLI_DIST, ...argv], {
      cwd: project,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(home, 'xdg-cache'),
        XDG_CONFIG_HOME: join(home, 'xdg-config'),
        NO_COLOR: '1',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bailout-discovery-trap');
    expect(existsSync(join(home, '.opensip-cli-coordination'))).toBe(true);
  });

  it('keeps a protected Tool-discovery failure structured for JSON callers', () => {
    const home = temp('opensip-lightweight-probe-home-');
    const project = temp('opensip-lightweight-probe-project-');
    stageIncompatibleAuthoredTool(home);
    const result = spawnSync(process.execPath, [CLI_DIST, 'agent-catalog', '--json'], {
      cwd: project,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(home, 'xdg-cache'),
        XDG_CONFIG_HOME: join(home, 'xdg-config'),
        NO_COLOR: '1',
      },
    });

    expect(result.status, result.stderr).toBe(5);
    const outcome = JSON.parse(result.stdout) as {
      readonly kind: string;
      readonly status: string;
      readonly errors: readonly { readonly message: string }[];
    };
    expect(outcome).toMatchObject({ kind: 'bootstrap.error', status: 'error' });
    expect(outcome.errors[0]?.message).toContain('bailout-discovery-trap');
  });
});
