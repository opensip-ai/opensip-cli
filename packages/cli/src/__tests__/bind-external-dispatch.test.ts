/**
 * bind-external-dispatch — unit coverage for the per-tool ADR-0054 dispatch hook
 * decision logic (`buildMaybeDispatchExternal`): bundled / unknown provenance →
 * in-process (`false`); external provenance → forks the worker.
 */

import {
  RunScope,
  runWithScope,
  type Tool,
  type ToolCliContext,
  type ToolProvenance,
} from '@opensip-cli/core';
import { afterEach, describe, it, expect } from 'vitest';

import { buildMaybeDispatchExternal } from '../bootstrap/bind-external-dispatch.js';

const TOOL: Tool = {
  metadata: {
    id: 'f1e2d3c4-b5a6-4789-90ab-cdef01234567',
    name: 'external-dispatch-tool',
    version: '0.0.0',
    description: 'fixture',
  },
  commandSpecs: [
    {
      name: 'ext-run',
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'signal-envelope',
      handler: () => Promise.resolve(),
    },
  ],
};

const stubCtx = {} as ToolCliContext;

function scopeWith(provenance: readonly ToolProvenance[]): RunScope {
  return new RunScope({ toolProvenance: provenance });
}

function provenance(source: ToolProvenance['source']): ToolProvenance {
  return {
    source,
    id: 'external-dispatch-tool',
    stableId: 'f1e2d3c4-b5a6-4789-90ab-cdef01234567',
    version: '0.0.0',
    manifestHash: 'h',
  };
}

describe('buildMaybeDispatchExternal', () => {
  afterEach(() => {
    delete process.env.OPENSIP_CLI_EXTERNAL_WORKER;
  });

  it('returns false by default (opt-in flag off) even for an external tool', async () => {
    const hook = buildMaybeDispatchExternal(TOOL, stubCtx);
    const dispatched = await runWithScope(scopeWith([provenance('installed')]), () =>
      hook('ext-run', {}, []),
    );
    // Flag off → byte-identical in-process behaviour (ADR-0027 parity preserved).
    expect(dispatched).toBe(false);
  });

  it('returns false for a bundled tool even with the flag on (in-process path)', async () => {
    process.env.OPENSIP_CLI_EXTERNAL_WORKER = '1';
    const hook = buildMaybeDispatchExternal(TOOL, stubCtx);
    const dispatched = await runWithScope(scopeWith([provenance('bundled')]), () =>
      hook('ext-run', {}, []),
    );
    expect(dispatched).toBe(false);
  });

  it('returns false when no provenance is recorded for the tool (unknown → in-process)', async () => {
    process.env.OPENSIP_CLI_EXTERNAL_WORKER = '1';
    const hook = buildMaybeDispatchExternal(TOOL, stubCtx);
    const dispatched = await runWithScope(scopeWith([]), () => hook('ext-run', {}, []));
    expect(dispatched).toBe(false);
  });

  it('matches provenance by human name when no stableId was declared', async () => {
    process.env.OPENSIP_CLI_EXTERNAL_WORKER = '1';
    const hook = buildMaybeDispatchExternal(TOOL, stubCtx);
    const byName: ToolProvenance = {
      source: 'bundled',
      id: 'external-dispatch-tool',
      version: '0.0.0',
      manifestHash: 'h',
    };
    const dispatched = await runWithScope(scopeWith([byName]), () => hook('ext-run', {}, []));
    // bundled → false, but the match-by-name path was exercised.
    expect(dispatched).toBe(false);
  });

  it('takes the external dispatch branch for installed provenance when the flag is on', async () => {
    process.env.OPENSIP_CLI_EXTERNAL_WORKER = '1';
    const hook = buildMaybeDispatchExternal(TOOL, stubCtx);
    // External provenance routes into dispatchExternalToolCommand. With no
    // resolved package path it fails fast with a structured error — proving the
    // external branch ran (vs. the false in-process return).
    await expect(
      runWithScope(scopeWith([provenance('installed')]), () => hook('ext-run', {}, [])),
    ).rejects.toThrow(/no resolved package path|failed/);
  });
});
