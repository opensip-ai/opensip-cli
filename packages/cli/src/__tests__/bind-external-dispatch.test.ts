/**
 * bind-external-dispatch — unit coverage for the per-tool ADR-0054 dispatch hook
 * decision logic (`buildMaybeDispatchExternal`).
 *
 * ADR-0054 M4-E trust-tier flip: external provenance forks the worker BY DEFAULT
 * (the former `OPENSIP_CLI_EXTERNAL_WORKER` opt-in gate is retired). Bundled /
 * unknown provenance stays in-process (`false`), byte-identical to before.
 */

import {
  RunScope,
  runWithScope,
  type Tool,
  type ToolCliContext,
  type ToolPluginManifest,
  type ToolProvenance,
} from '@opensip-cli/core';
import { describe, it, expect } from 'vitest';

import { buildMaybeDispatchExternal } from '../bootstrap/bind-external-dispatch.js';

const TOOL: Tool = {
  identity: { name: 'external-dispatch-tool', aliases: ['ext-run'] },
  metadata: {
    id: 'f1e2d3c4-b5a6-4789-90ab-cdef01234567',
    name: 'external-dispatch-tool',
    version: '0.0.0',
    description: 'fixture',
  },
  commandSpecs: [
    {
      name: 'external-dispatch-tool',
      aliases: ['ext-run'],
      description: 'fixture',
      commonFlags: [],
      scope: 'project',
      output: 'signal-envelope',
      handler: () => Promise.resolve(),
    },
  ],
};

const stubCtx = {} as ToolCliContext;

function scopeWith(
  provenance: readonly ToolProvenance[],
  extras: {
    readonly toolManifests?: readonly ToolPluginManifest[];
    readonly configDocument?: Readonly<Record<string, unknown>>;
  } = {},
): RunScope {
  const scope = new RunScope({
    toolProvenance: provenance,
    ...(extras.toolManifests === undefined ? {} : { toolManifests: extras.toolManifests }),
  });
  // `configDocument` is an Object.assign-installed scope slot (not a constructor
  // option), mirroring how the bootstrap stamps the validated document.
  if (extras.configDocument !== undefined) {
    Object.assign(scope, { configDocument: extras.configDocument });
  }
  return scope;
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
  it('returns false for a bundled tool (in-process path, byte-identical to before)', async () => {
    const hook = buildMaybeDispatchExternal(TOOL, stubCtx);
    const dispatched = await runWithScope(scopeWith([provenance('bundled')]), () =>
      hook('ext-run', {}, []),
    );
    expect(dispatched).toBe(false);
  });

  it('returns false when no provenance is recorded for the tool (unknown → in-process)', async () => {
    const hook = buildMaybeDispatchExternal(TOOL, stubCtx);
    const dispatched = await runWithScope(scopeWith([]), () => hook('ext-run', {}, []));
    expect(dispatched).toBe(false);
  });

  it('matches provenance by human name when no stableId was declared', async () => {
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

  it('forks the worker BY DEFAULT for installed provenance (no opt-in gate; M4-E flip)', async () => {
    const hook = buildMaybeDispatchExternal(TOOL, stubCtx);
    // External provenance routes into dispatchExternalToolCommand with NO env gate
    // set. With no resolved package path it fails fast with a structured error —
    // proving the external branch ran (vs. the false in-process return).
    await expect(
      runWithScope(scopeWith([provenance('installed')]), () => hook('ext-run', {}, [])),
    ).rejects.toThrow(/no resolved package path|cannot isolate|failed/);
  });

  it('forks by default for project-local and user-global provenance too', async () => {
    const hook = buildMaybeDispatchExternal(TOOL, stubCtx);
    for (const source of ['project-local', 'user-global'] as const) {
      await expect(
        runWithScope(scopeWith([provenance(source)]), () => hook('ext-run', {}, [])),
      ).rejects.toThrow(/no resolved package path|cannot isolate|failed/);
    }
  });

  it('still forks an external tool — NO_WORKER does not apply to external dispatch (bundled-only)', async () => {
    // OPENSIP_CLI_NO_WORKER is bundled-only (ADR-0054 trust tier). An external
    // tool ignores it and still attempts the fork (which fails fast here with no
    // package dir, proving the external branch ran rather than an in-host run).
    const prev = process.env.OPENSIP_CLI_NO_WORKER;
    process.env.OPENSIP_CLI_NO_WORKER = '1';
    try {
      const hook = buildMaybeDispatchExternal(TOOL, stubCtx);
      await expect(
        runWithScope(scopeWith([provenance('installed')]), () => hook('ext-run', {}, [])),
      ).rejects.toThrow(/no resolved package path|cannot isolate|failed/);
    } finally {
      if (prev === undefined) delete process.env.OPENSIP_CLI_NO_WORKER;
      else process.env.OPENSIP_CLI_NO_WORKER = prev;
    }
  });

  it('threads the tool config namespace block from the document for the worker deep pass', async () => {
    // The hook resolves the namespace from the tool manifest descriptor and the
    // block from scope.configDocument; passing them into the dispatch supervisor.
    // We assert the external branch ran (fails fast, no package dir) WITH a
    // manifest descriptor + a config block present in the document.
    const manifest: ToolPluginManifest = {
      kind: 'tool',
      id: 'external-dispatch-tool',
      identity: { name: 'external-dispatch-tool', aliases: ['ext-run'] },
      stableId: 'f1e2d3c4-b5a6-4789-90ab-cdef01234567',
      name: 'external-dispatch-tool',
      version: '0.0.0',
      apiVersion: 1,
      commands: [{ name: 'external-dispatch-tool', aliases: ['ext-run'], description: 'fixture' }],
      config: {
        namespace: 'external-dispatch-tool',
        schema: { type: 'object', properties: {} },
      },
    };
    const hook = buildMaybeDispatchExternal(TOOL, stubCtx);
    await expect(
      runWithScope(
        scopeWith([provenance('installed')], {
          toolManifests: [manifest],
          configDocument: { 'external-dispatch-tool': { k: 'v' } },
        }),
        () => hook('ext-run', {}, []),
      ),
    ).rejects.toThrow(/no resolved package path|cannot isolate|failed/);
  });
});
