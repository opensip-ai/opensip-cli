/**
 * `tools` group leaf specs (ADR-0041) — the CommandSpec handlers that wire the
 * customer-facing `tools list|validate|install|uninstall|data-purge` group.
 * The handler ORCHESTRATION (flag-conflict rejections, exit-code setting on a
 * non-passing verdict / failed op, the post-uninstall project purge) is the
 * logic under test here; the effectful delegates (validate/install/uninstall/
 * data-purge — all of which shell out to npm or SQLite) are mocked so the
 * branches are reachable without a real install. `toolsList` stays real (it is
 * pure). Previously these handlers only ran under the subprocess surface
 * (coverage-invisible).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXIT_CODES } from '@opensip-cli/contracts';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliCommandsContext } from '../commands/shared.js';
import type { CommandSpec } from '@opensip-cli/core';

const runToolValidation = vi.fn();
const toolsInstall = vi.fn();
const toolsUninstall = vi.fn();
const toolsDataPurge = vi.fn();

vi.mock('../commands/tools/validate.js', () => ({
  runToolValidation: (...a: unknown[]) => runToolValidation(...a),
}));
vi.mock('../commands/tools/install.js', () => ({
  toolsInstall: (...a: unknown[]) => toolsInstall(...a),
}));
vi.mock('../commands/tools/uninstall.js', () => ({
  toolsUninstall: (...a: unknown[]) => toolsUninstall(...a),
}));
vi.mock('../commands/tools/data-purge.js', () => ({
  toolsDataPurge: (...a: unknown[]) => toolsDataPurge(...a),
}));

const { buildToolsGroupLeaves } = await import('../commands/tools/index.js');

type Handler = (rawOpts: unknown) => unknown;

let exitCodes: number[];
let ds: DataStore | undefined;
let tmp: string;

function makeCtx(): CliCommandsContext {
  return {
    setExitCode: (code: number) => exitCodes.push(code),
    datastore: () => ds,
  } as unknown as CliCommandsContext;
}

/** Resolve one leaf's handler by subcommand name. */
function handlerFor(name: string): Handler {
  const leaf = buildToolsGroupLeaves(makeCtx()).find(
    (s: CommandSpec<unknown, CliCommandsContext>) => s.name === name,
  );
  if (!leaf?.handler) throw new Error(`no handler for ${name}`);
  return leaf.handler as Handler;
}

beforeEach(() => {
  exitCodes = [];
  tmp = mkdtempSync(join(tmpdir(), 'ost-tools-index-'));
  ds = undefined;
  for (const m of [runToolValidation, toolsInstall, toolsUninstall, toolsDataPurge]) m.mockReset();
});

afterEach(() => {
  ds?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('tools list handler', () => {
  it('returns a tools-list result from the (real, pure) inventory builder', async () => {
    const result = (await handlerFor('list')({ cwd: tmp })) as { type: string };
    expect(result.type).toBe('tools-list');
  });
});

describe('tools validate handler', () => {
  it('returns the validation result and sets no exit code on a passing verdict', async () => {
    runToolValidation.mockResolvedValue({
      result: {
        type: 'tools-validate',
        spec: 'x',
        verdict: 'passed',
        sections: [],
      },
    });
    const result = (await handlerFor('validate')({
      cwd: tmp,
      _args: ['x'],
    })) as {
      verdict: string;
    };
    expect(result.verdict).toBe('passed');
    expect(exitCodes).toEqual([]);
  });

  it('sets the configuration-error exit code on a non-passing verdict', async () => {
    runToolValidation.mockResolvedValue({
      result: {
        type: 'tools-validate',
        spec: 'x',
        verdict: 'failed',
        sections: [],
      },
    });
    await handlerFor('validate')({ cwd: tmp, _args: ['x'], installDeps: true });
    expect(exitCodes).toContain(EXIT_CODES.CONFIGURATION_ERROR);
  });
});

describe('tools install handler', () => {
  it('rejects --global + --project as mutually exclusive without delegating', async () => {
    const result = (await handlerFor('install')({
      cwd: tmp,
      _args: ['pkg'],
      global: true,
      project: true,
    })) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mutually exclusive/);
    expect(toolsInstall).not.toHaveBeenCalled();
    expect(exitCodes).toContain(EXIT_CODES.CONFIGURATION_ERROR);
  });

  it('delegates a valid install and passes success through', async () => {
    toolsInstall.mockResolvedValue({
      type: 'tools-install',
      spec: 'pkg',
      success: true,
    });
    const result = (await handlerFor('install')({
      cwd: tmp,
      _args: ['pkg'],
      project: true,
    })) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(toolsInstall).toHaveBeenCalledWith({
      spec: 'pkg',
      cwd: tmp,
      project: true,
    });
    expect(exitCodes).toEqual([]);
  });

  it('sets the exit code when the install fails', async () => {
    toolsInstall.mockResolvedValue({
      type: 'tools-install',
      spec: 'pkg',
      success: false,
    });
    await handlerFor('install')({ cwd: tmp, _args: ['pkg'] });
    expect(exitCodes).toContain(EXIT_CODES.CONFIGURATION_ERROR);
  });
});

describe('tools uninstall handler', () => {
  it('rejects --purge-data combined with --global', async () => {
    const result = (await handlerFor('uninstall')({
      cwd: tmp,
      _args: ['t'],
      global: true,
      purgeData: true,
    })) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/project-local only/);
    expect(toolsUninstall).not.toHaveBeenCalled();
  });

  it('sets the exit code and returns when the uninstall fails', async () => {
    toolsUninstall.mockReturnValue({
      type: 'tools-uninstall',
      target: 't',
      success: false,
    });
    await handlerFor('uninstall')({ cwd: tmp, _args: ['t'] });
    expect(exitCodes).toContain(EXIT_CODES.CONFIGURATION_ERROR);
    expect(toolsDataPurge).not.toHaveBeenCalled();
  });

  it('purges project SQLite rows after a successful --purge-data project uninstall', async () => {
    ds = DataStoreFactory.open({ backend: 'memory' });
    toolsUninstall.mockReturnValue({
      type: 'tools-uninstall',
      target: 't',
      success: true,
      removed: { id: 'demo', packageName: '@x/demo', scope: 'project' },
    });
    toolsDataPurge.mockReturnValue({
      type: 'tools-data-purge',
      toolId: 'demo',
      sessions: 2,
      baselineEntries: 1,
      baselineMeta: false,
      stateRows: 3,
    });
    const result = (await handlerFor('uninstall')({
      cwd: tmp,
      _args: ['t'],
      project: true,
      purgeData: true,
    })) as { success: boolean };
    expect(result.success).toBe(true);
    expect(toolsDataPurge).toHaveBeenCalledWith('demo', ds);
  });

  it('skips the purge when --purge-data is not set even on a project uninstall', async () => {
    ds = DataStoreFactory.open({ backend: 'memory' });
    toolsUninstall.mockReturnValue({
      type: 'tools-uninstall',
      target: 't',
      success: true,
      removed: { id: 'demo', packageName: '@x/demo', scope: 'project' },
    });
    await handlerFor('uninstall')({ cwd: tmp, _args: ['t'], project: true });
    expect(toolsDataPurge).not.toHaveBeenCalled();
  });
});

describe('tools handlers — empty argv defaults to an empty spec/target', () => {
  it('install rejection, uninstall rejection, and data-purge error all tolerate missing _args', async () => {
    const install = (await handlerFor('install')({
      cwd: tmp,
      _args: [],
      global: true,
      project: true,
    })) as { target: string };
    expect(install.target).toBe('');

    const uninstall = (await handlerFor('uninstall')({
      cwd: tmp,
      _args: [],
      global: true,
      purgeData: true,
    })) as { target: string };
    expect(uninstall.target).toBe('');

    ds = undefined;
    const purge = (await handlerFor('data-purge')({ cwd: tmp, _args: [] })) as {
      target: string;
    };
    expect(purge.target).toBe('');
  });
});

describe('tools data-purge handler', () => {
  it('errors when no project datastore is available', async () => {
    ds = undefined;
    const result = (await handlerFor('data-purge')({
      cwd: tmp,
      _args: ['demo'],
    })) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires the project datastore/);
    expect(exitCodes).toContain(EXIT_CODES.CONFIGURATION_ERROR);
  });

  it('delegates to the purge when a datastore is present', async () => {
    ds = DataStoreFactory.open({ backend: 'memory' });
    toolsDataPurge.mockReturnValue({
      type: 'tools-data-purge',
      toolId: 'demo',
      sessions: 0,
      baselineEntries: 0,
      baselineMeta: false,
      stateRows: 0,
    });
    const result = (await handlerFor('data-purge')({
      cwd: tmp,
      _args: ['demo'],
    })) as {
      type: string;
    };
    expect(result.type).toBe('tools-data-purge');
    expect(toolsDataPurge).toHaveBeenCalledWith('demo', ds);
  });
});
