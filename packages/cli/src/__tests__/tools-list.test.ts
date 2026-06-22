/**
 * `tools list` (plan phase 7.2): the zero-dynamic-import proof — a tool whose
 * module top-level THROWS still lists cleanly (listing reads manifests, never
 * imports) — plus shadow-marking and the scope filters. Drives the dist CLI
 * with a redirected HOME so the user-global host is hermetic.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { distRunner } from './harness/cli-acceptance.js';

let projectDir: string;
let fakeHome: string;

/** Write a marker+manifest package into a tool host's node_modules. */
function writeToolPackage(hostDir: string, pkgName: string, toolId: string, body: string): void {
  const pkgDir = join(hostDir, 'node_modules', pkgName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: pkgName,
      version: '1.2.3',
      private: true,
      type: 'module',
      main: './index.js',
      opensipTools: {
        kind: 'tool',
        id: toolId,
        apiVersion: 1,
        commands: [{ name: `${toolId}-cmd`, description: 'fixture' }],
      },
    }),
  );
  writeFileSync(join(pkgDir, 'index.js'), body);
}

beforeAll(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ost-tools-list-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'ost-tools-list-home-'));
  const init = distRunner().run(['init', '--language', 'typescript'], {
    cwd: projectDir,
    env: { ...process.env, HOME: fakeHome },
  });
  expect(init.exitCode).toBe(0);

  const projectHost = join(projectDir, 'opensip-cli', '.runtime', 'plugins', 'tool');
  const globalHost = join(fakeHome, '.opensip-cli', 'plugins', 'tool');
  // The THROWING tool: a runtime import would crash; listing must not care.
  writeToolPackage(
    projectHost,
    '@fixture/throwing-tool',
    'throwing-tool',
    'throw new Error("module top-level explosion");',
  );
  // Shadow pair: same tool id in both hosts.
  writeToolPackage(projectHost, '@fixture/shadow-project', 'shadow-tool', 'export const tool = 1;');
  writeToolPackage(globalHost, '@fixture/shadow-global', 'shadow-tool', 'export const tool = 1;');
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

interface Row {
  id: string;
  source: string;
  status: string;
  shadowed?: boolean;
  version: string;
}

function listRows(extra: readonly string[] = []): { rows: Row[]; exitCode: number } {
  const r = distRunner().run(['tools', 'list', '--json', ...extra], {
    cwd: projectDir,
    env: { ...process.env, HOME: fakeHome },
  });
  if (r.exitCode !== 0) return { rows: [], exitCode: r.exitCode };
  const parsed = JSON.parse(r.stdout) as { data: { tools: Row[] } };
  return { rows: parsed.data.tools, exitCode: r.exitCode };
}

describe('tools list', () => {
  it('lists a tool whose module top-level throws (zero dynamic imports)', () => {
    const { rows, exitCode } = listRows();
    expect(exitCode).toBe(0);
    const throwing = rows.find((t) => t.id === 'throwing-tool');
    expect(throwing).toBeDefined();
    expect(throwing?.status).toBe('manifest-only');
    expect(throwing?.version).toBe('1.2.3');
  });

  it('marks the global row shadowed when a project row shares its id', () => {
    const { rows } = listRows();
    const shadows = rows.filter((t) => t.id === 'shadow-tool');
    expect(shadows).toHaveLength(2);
    expect(shadows.find((t) => t.source === 'global')?.shadowed).toBe(true);
    expect(shadows.find((t) => t.source === 'project')?.shadowed).toBeUndefined();
  });

  it('--project and --global filter to one scope (bundled rows only unfiltered)', () => {
    const project = listRows(['--project']);
    expect(project.rows.every((t) => t.source === 'project')).toBe(true);
    expect(project.rows.map((t) => t.id).sort()).toEqual(['shadow-tool', 'throwing-tool']);

    const global = listRows(['--global']);
    expect(global.rows.every((t) => t.source === 'global')).toBe(true);
    expect(global.rows.map((t) => t.id)).toEqual(['shadow-tool']);

    const all = listRows();
    const bundled = all.rows.filter((t) => t.source === 'bundled').map((t) => t.id);
    // Task 2.4: the tool id (human key = metadata.name) is the short verb.
    expect([...bundled].sort()).toEqual(['fit', 'graph', 'sim', 'yagni']);
  });
});
