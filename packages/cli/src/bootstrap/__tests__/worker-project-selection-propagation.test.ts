import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RunScope, runWithScope, type ProjectContext } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeDispatchHostCtx } from '../../__tests__/harness/dispatch-host-ctx.js';
import { runCapabilityWorkerSpec } from '../capability-worker/supervisor.js';
import { runWorkerSpec } from '../dispatch-fork-core.js';

import type { CapabilityWorkerSpec } from '../capability-worker/types.js';
import type { ToolCommandWorkerSpec } from '../tool-command-dispatch-types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGV_PROBE_WORKER = join(HERE, 'fixtures', 'worker-argv-probe.mjs');

let container: string;
let cwd: string;
let configPath: string;

beforeEach(() => {
  container = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-worker-selection-')));
  const projectRoot = join(container, 'project with spaces');
  cwd = join(projectRoot, 'packages', 'selected cwd');
  configPath = join(projectRoot, 'config', 'custom opensip.yml');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, '{}\n');
  cwd = realpathSync(cwd);
  configPath = realpathSync(configPath);
});

afterEach(() => {
  rmSync(container, { recursive: true, force: true });
});

function projectScope(): RunScope {
  const projectRoot = dirname(dirname(configPath));
  const projectContext: ProjectContext = {
    cwd,
    cwdExplicit: true,
    projectRoot,
    configPath,
    walkedUp: 2,
    scope: 'project',
  };
  return new RunScope({ runId: 'run_worker_project_selection', projectContext });
}

function expectProjectSelectionArgs(argv: readonly string[], subcommand: string): void {
  expect(argv).toHaveLength(6);
  expect(argv[0]).toBe(subcommand);
  expect(argv[1]).toMatch(/[/\\]spec\.json$/u);
  expect(argv.slice(2)).toEqual(['--cwd', cwd, '--config', configPath]);
}

describe('worker project-selection propagation', () => {
  it('passes the resolved cwd and absolute custom config to an external-tool worker', async () => {
    const relativeCwd = relative(container, cwd);
    const spec: ToolCommandWorkerSpec = {
      toolId: 'external-worker-project-selection',
      toolPackageDir: container,
      source: 'installed',
      commandName: 'probe',
      opts: { cwd: relativeCwd },
      positionals: [],
    };

    const result = await runWithScope(projectScope(), () =>
      runWorkerSpec({
        spec,
        ctx: makeDispatchHostCtx().ctx,
        cwd: relativeCwd,
        cliScript: ARGV_PROBE_WORKER,
        timeoutMs: 5000,
      }),
    );

    const returned = result.returned as {
      readonly argv: readonly string[];
      readonly specCwd: string;
    };
    expectProjectSelectionArgs(returned.argv, '__tool-command-worker');
    expect(returned.specCwd).toBe(cwd);
  });

  it('passes the resolved cwd and absolute custom config to a capability worker', async () => {
    const spec: CapabilityWorkerSpec = {
      ownerToolId: 'capability-owner',
      domainId: 'probe-domain',
      descriptor: {
        discovery: { mode: 'marker', markerKind: 'probe-pack' },
        exportName: 'probes',
        exportShape: 'array',
        configKeys: {},
      },
      pkg: {
        name: '@fixture/probe-pack',
        packageDir: container,
      },
      resourceDecision: {
        isolation: 'worker',
        allowedResources: [],
        denyUndeclared: true,
        reasons: ['test worker isolation'],
      },
      request: { kind: 'probe' },
    };

    const result = await runWithScope(projectScope(), () =>
      runCapabilityWorkerSpec({
        spec,
        cwd,
        cliScript: ARGV_PROBE_WORKER,
        timeoutMs: 5000,
      }),
    );

    expectProjectSelectionArgs(result as readonly string[], '__capability-pack-worker');
  });
});
