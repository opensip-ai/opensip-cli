/**
 * Built-CLI coverage for internal live workers. These commands re-enter the
 * complete CLI bootstrap, so unit-level descriptor assertions are not enough:
 * no-init eligibility and explicit custom config selection must survive the
 * actual process boundary.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
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

function stageTypeScriptProject(project: string): string {
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(
    join(project, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true } }),
    'utf8',
  );
  writeFileSync(join(project, 'src', 'index.ts'), 'export const answer = 42;\n', 'utf8');
  const specPath = join(project, 'fit-worker-spec.json');
  writeFileSync(
    specPath,
    JSON.stringify({
      cwd: project,
      list: false,
      recipes: false,
      json: true,
      verbose: false,
      exclude: [],
      debug: false,
      check: 'no-console-log',
    }),
    'utf8',
  );
  return specPath;
}

function stageGraphSpec(project: string): string {
  const specPath = join(project, 'graph-worker-spec.json');
  writeFileSync(
    specPath,
    JSON.stringify({
      cwd: project,
      noCache: true,
      resolution: 'fast',
    }),
    'utf8',
  );
  return specPath;
}

function runInternalWorker(
  command: 'fit-run-worker' | 'graph-run-worker',
  project: string,
  specPath: string,
  home: string,
  configPath?: string,
): SpawnSyncReturns<string> {
  return spawnSync(
    process.execPath,
    [
      CLI_DIST,
      command,
      specPath,
      '--cwd',
      project,
      ...(configPath === undefined ? [] : ['--config', configPath]),
    ],
    {
      cwd: project,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(home, 'xdg-cache'),
        XDG_CONFIG_HOME: join(home, 'xdg-config'),
        NO_COLOR: '1',
      },
    },
  );
}

afterEach(() => {
  for (const path of staged.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('internal worker project selection', () => {
  it('boots a fit worker against an uninitialized project without authoring project state', () => {
    const project = temp('opensip-worker-no-init-project-');
    const home = temp('opensip-worker-no-init-home-');
    const specPath = stageTypeScriptProject(project);

    const result = runInternalWorker('fit-run-worker', project, specPath, home);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(project, 'opensip-cli'))).toBe(false);
    expect(existsSync(join(home, '.opensip-cli', 'cache', 'ephemeral'))).toBe(true);
  }, 60_000);

  it('boots a graph worker against an uninitialized project without authoring project state', () => {
    const project = temp('opensip-graph-worker-no-init-project-');
    const home = temp('opensip-graph-worker-no-init-home-');
    stageTypeScriptProject(project);
    const specPath = stageGraphSpec(project);

    const result = runInternalWorker('graph-run-worker', project, specPath, home);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(project, 'opensip-cli'))).toBe(false);
    expect(existsSync(join(home, '.opensip-cli', 'cache', 'ephemeral'))).toBe(true);
  }, 60_000);

  it('boots against a non-default config path and selects project-local runtime state', () => {
    const project = temp('opensip-worker-custom-config-project-');
    const home = temp('opensip-worker-custom-config-home-');
    const specPath = stageTypeScriptProject(project);
    const configPath = join(project, 'custom config.yml');
    writeFileSync(configPath, 'schemaVersion: 1\ntargets: {}\n', 'utf8');

    const result = runInternalWorker('fit-run-worker', project, specPath, home, configPath);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(project, 'opensip-cli', '.runtime'))).toBe(true);
  }, 60_000);
});
