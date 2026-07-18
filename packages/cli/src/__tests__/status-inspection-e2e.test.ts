/**
 * Requires a built CLI. Proves the pre-bootstrap inspection route does not
 * discover authored Tools or create persistent status state.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const CLI_DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const staged: string[] = [];

afterEach(() => {
  for (const path of staged.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  staged.push(path);
  return path;
}

function stageIncompatibleDiscoveryTrap(home: string): void {
  const toolDir = join(home, '.opensip-cli', 'tools', 'status-discovery-trap');
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(join(toolDir, 'index.js'), 'throw new Error("must not import");\n', 'utf8');
  writeFileSync(
    join(toolDir, 'opensip-tool.manifest.json'),
    JSON.stringify({
      kind: 'tool',
      id: 'status-discovery-trap',
      identity: { name: 'status-discovery-trap' },
      name: 'Status discovery trap',
      version: '1.0.0',
      // Ordinary bootstrap fails closed while admitting this manifest. Status
      // can succeed only if its pre-bootstrap branch skips discovery entirely.
      apiVersion: 999,
      main: './index.js',
      commands: [{ name: 'status-discovery-trap', description: 'trap' }],
    }),
    'utf8',
  );
}

function allRelativeFiles(root: string, relative = ''): string[] {
  const directory = join(root, relative);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(relative, entry.name);
    return entry.isDirectory() ? allRelativeFiles(root, child) : [child];
  });
}

function snapshotFiles(
  root: string,
): Record<string, { readonly content: string; readonly mtimeMs: number }> {
  return Object.fromEntries(
    allRelativeFiles(root)
      .sort()
      .map((relative) => {
        const path = join(root, relative);
        return [
          relative,
          {
            content: readFileSync(path).toString('base64'),
            mtimeMs: statSync(path).mtimeMs,
          },
        ];
      }),
  );
}

describe('status inspection-only startup', () => {
  it('skips Tool discovery and leaves cache, logs, datastore, report, update, and coordination absent', () => {
    const home = temp('opensip-status-home-');
    const project = temp('opensip-status-project-');
    stageIncompatibleDiscoveryTrap(home);
    writeFileSync(
      join(project, 'opensip-cli.config.yml'),
      'schemaVersion: 1\ntargets: {}\n',
      'utf8',
    );
    const env = {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, 'xdg-cache'),
      XDG_CONFIG_HOME: join(home, 'xdg-config'),
    };

    const stdout = execFileSync(
      process.execPath,
      [CLI_DIST, '--no-cloud', 'status', '--json', '--cwd', project],
      { env, encoding: 'utf8' },
    );
    const outcome = JSON.parse(stdout) as {
      status?: string;
      data?: { type?: string };
    };
    expect(outcome).toMatchObject({
      status: 'ok',
      data: { type: 'runtime-status' },
    });
    expect(existsSync(join(home, '.opensip-cli', 'update-state.json'))).toBe(false);
    expect(existsSync(join(home, '.opensip-cli', 'cache'))).toBe(false);
    expect(existsSync(join(home, '.opensip-cli-coordination'))).toBe(false);
    expect(existsSync(join(project, 'opensip-cli'))).toBe(false);

    const invalid = spawnSync(process.execPath, [CLI_DIST, 'status', '--definitely-invalid'], {
      env,
      encoding: 'utf8',
    });
    expect(invalid.status).not.toBe(0);
    expect(existsSync(join(home, '.opensip-cli-coordination'))).toBe(false);

    // Control: the same staged sidecar is genuinely reached by ordinary
    // bootstrap, so status succeeding above is meaningful evidence that the
    // inspection-only branch skipped authored Tool discovery.
    const ordinary = spawnSync(
      process.execPath,
      [CLI_DIST, '--no-cloud', 'agent-catalog', '--json'],
      { cwd: project, env, encoding: 'utf8' },
    );
    expect(ordinary.status).not.toBe(0);
    const ordinaryOutcome = JSON.parse(ordinary.stdout) as {
      readonly kind?: string;
      readonly errors?: readonly { readonly message?: string }[];
    };
    expect(ordinaryOutcome.kind).toBe('bootstrap.error');
    expect(ordinaryOutcome.errors?.[0]?.message).toMatch(/incompatible|api version/i);
    expect(
      allRelativeFiles(join(home, '.opensip-cli-coordination')).filter(
        (path) => path.includes('readers') || path.includes('user-readers'),
      ),
    ).toEqual([]);
    const stateFile = join(home, '.opensip-cli-coordination', 'state.json');
    if (existsSync(stateFile)) {
      expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ writers: [] });
    }
  });

  it('leaves pre-existing cache, update, log, report, and datastore files unchanged', () => {
    const home = temp('opensip-status-existing-home-');
    const project = temp('opensip-status-existing-project-');
    stageIncompatibleDiscoveryTrap(home);
    writeFileSync(
      join(project, 'opensip-cli.config.yml'),
      'schemaVersion: 1\ntargets: {}\n',
      'utf8',
    );
    const userState = join(home, '.opensip-cli');
    const projectState = join(project, 'opensip-cli');
    const projectRuntime = join(projectState, '.runtime');
    for (const directory of [
      join(userState, 'cache', 'sentinel-runtime'),
      join(projectRuntime, 'logs'),
      join(projectRuntime, 'reports'),
    ]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(
      join(userState, 'cache', 'sentinel-runtime', 'project.json'),
      '{"lastUsedAt":"2020-01-01T00:00:00.000Z","sentinel":true}\n',
      'utf8',
    );
    writeFileSync(
      join(userState, 'update-state.json'),
      '{"lastCheckedAt":"2020-01-01T00:00:00.000Z"}\n',
      'utf8',
    );
    writeFileSync(join(projectRuntime, 'logs', 'sentinel.log'), 'do not touch\n', 'utf8');
    writeFileSync(join(projectRuntime, 'reports', 'sentinel.html'), '<p>sentinel</p>\n', 'utf8');
    writeFileSync(join(projectRuntime, 'datastore.sqlite'), 'sentinel sqlite bytes\n', 'utf8');
    const beforeUser = snapshotFiles(userState);
    const beforeProject = snapshotFiles(projectState);
    const env = {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: join(home, 'xdg-cache'),
      XDG_CONFIG_HOME: join(home, 'xdg-config'),
      NO_COLOR: '1',
    };

    const result = spawnSync(process.execPath, [CLI_DIST, 'status', '--json', '--cwd', project], {
      cwd: project,
      env,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(snapshotFiles(userState)).toEqual(beforeUser);
    expect(snapshotFiles(projectState)).toEqual(beforeProject);
    expect(existsSync(join(home, '.opensip-cli-coordination'))).toBe(false);
  });
});
