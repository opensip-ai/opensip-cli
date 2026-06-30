/**
 * `toolsInstall` unit coverage (ADR-0041) — the atomic stage → validate →
 * activate orchestration. Every boundary it crosses shells out (npm pack, npm
 * install, validation staging), so they are mocked to drive the branch matrix:
 * a non-passing verdict short-circuits before activation; activation failure
 * (typed + untyped) surfaces an error; the success path packs the STAGED dir,
 * activates, and reads the inventory manifest; `cleanup` always runs in
 * `finally`. The subprocess install test is coverage-invisible; this is direct.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolsValidateResult } from '@opensip-cli/contracts';

const runToolValidation = vi.fn();
const addToolPlugin = vi.fn();
const admitToolPackage = vi.fn();
const recordInstalledToolTrust = vi.fn();
const execFileSync = vi.fn();
const cleanup = vi.fn();

vi.mock('../commands/tools/validate.js', () => ({
  runToolValidation: (...a: unknown[]) => runToolValidation(...a),
}));
vi.mock('../commands/plugin-host-ops.js', () => ({
  addToolPlugin: (...a: unknown[]) => addToolPlugin(...a),
}));
vi.mock('../bootstrap/admit-tool-package.js', () => ({
  admitToolPackage: (...a: unknown[]) => admitToolPackage(...a),
}));
vi.mock('../bootstrap/tool-trust.js', () => ({
  recordInstalledToolTrust: (...a: unknown[]) => recordInstalledToolTrust(...a),
}));
vi.mock('node:child_process', () => ({
  execFileSync: (...a: unknown[]) => execFileSync(...a),
}));

const { toolsInstall } = await import('../commands/tools/install.js');

function validation(verdict: ToolsValidateResult['verdict']): ToolsValidateResult {
  return { type: 'tools-validate', spec: '@x/demo', verdict, sections: [] };
}

/** Make runToolValidation resolve a verdict, with a staged dir + cleanup spy. */
function stageValidation(verdict: ToolsValidateResult['verdict'], stagedPkgDir = '/staged/demo') {
  runToolValidation.mockResolvedValue({
    result: validation(verdict),
    stagedPkgDir,
    cleanup,
  });
}

beforeEach(() => {
  for (const m of [
    runToolValidation,
    addToolPlugin,
    admitToolPackage,
    recordInstalledToolTrust,
    execFileSync,
    cleanup,
  ]) {
    m.mockReset();
  }
  // npm pack prints the tarball name on the last stdout line.
  execFileSync.mockReturnValue('npm notice\ndemo-1.0.0.tgz\n');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toolsInstall — validation gate', () => {
  it('short-circuits to failure when the verdict is not passed (no activation)', async () => {
    stageValidation('failed');
    const result = await toolsInstall({ spec: '@x/demo', cwd: '/proj' });
    expect(result.success).toBe(false);
    expect(result.scope).toBe('global');
    expect(result.validation.verdict).toBe('failed');
    expect(addToolPlugin).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1); // finally still runs
  });
});

describe('toolsInstall — activation', () => {
  it('packs the staged dir, activates, and reports the admitted manifest on success', async () => {
    stageValidation('passed', '/staged/demo');
    addToolPlugin.mockReturnValue({
      type: 'plugin-add',
      packageName: '@x/demo',
      success: true,
    });
    admitToolPackage.mockResolvedValue({
      manifest: {
        id: 'demo',
        version: '1.0.0',
        commands: [{ name: 'demo-run', description: 'run demo' }],
      },
      provenance: { manifestHash: 'manifest-hash-demo' },
    });

    const result = await toolsInstall({
      spec: '@x/demo',
      cwd: '/proj',
      project: true,
    });
    expect(result.success).toBe(true);
    expect(result.scope).toBe('project');
    expect(result.toolId).toBe('demo');
    expect(result.version).toBe('1.0.0');
    expect(result.trustReason).toBe('managed-install');
    expect(result.nextSteps).toEqual(['opensip demo-run']);
    // npm pack runs FROM the staged dir, into the staged dir.
    expect(execFileSync).toHaveBeenCalledWith(
      'npm',
      ['pack', '--pack-destination', '/staged/demo', '.'],
      expect.objectContaining({ cwd: '/staged/demo' }),
    );
    // Activation installs the packed tarball, not a re-resolve of the spec.
    expect(addToolPlugin).toHaveBeenCalledWith('/staged/demo/demo-1.0.0.tgz', '/proj', true);
    expect(recordInstalledToolTrust).toHaveBeenCalledWith({
      scope: 'project',
      cwd: '/proj',
      toolId: 'demo',
      packageName: '@x/demo',
      version: '1.0.0',
      manifestHash: 'manifest-hash-demo',
      installSourcePath: '/staged/demo',
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('omits toolId/version when the admitted package has no manifest', async () => {
    stageValidation('passed');
    addToolPlugin.mockReturnValue({ type: 'plugin-add', success: true });
    admitToolPackage.mockResolvedValue({ manifest: undefined });

    const result = await toolsInstall({ spec: '@x/demo', cwd: '/proj' });
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty('toolId');
    expect(result).not.toHaveProperty('version');
  });

  it('surfaces a typed activation error', async () => {
    stageValidation('passed');
    addToolPlugin.mockReturnValue({
      type: 'plugin-add',
      success: false,
      error: 'npm install failed',
    });

    const result = await toolsInstall({ spec: '@x/demo', cwd: '/proj' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('npm install failed');
    expect(admitToolPackage).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when activation returns an unexpected shape', async () => {
    stageValidation('passed');
    // Wrong result type → not plugin-add → the `'error' in activation ? … : 'activation failed'`
    // false branch (no error key present).
    addToolPlugin.mockReturnValue({ type: 'plugin-remove', success: false });

    const result = await toolsInstall({ spec: '@x/demo', cwd: '/proj' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('activation failed');
  });
});
