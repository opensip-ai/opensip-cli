/**
 * bind-external-dispatch — unit coverage for {@link buildMaybeDispatchExternal},
 * the per-tool ADR-0054 out-of-process dispatch hook. Exercised IN-PROCESS with
 * the fork supervisor (`dispatchExternalToolCommand`) STUBBED, so the host-side
 * branch logic — provenance gate, the stable-id-then-name manifest match, and the
 * raw-config-block lookup — runs deterministically without forking a worker.
 *
 * The fork boundary itself is proven in `external-tool-dispatch.test.ts`; here we
 * isolate the host-side resolution branches that decide WHETHER to fork and WHAT
 * config block to forward.
 */

import { RunScope, runWithScope, runWithScopeSync } from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildMaybeDispatchExternal } from '../bind-external-dispatch.js';

import type { Tool, ToolCliContext, ToolPluginManifest, ToolProvenance } from '@opensip-cli/core';

// Stub the fork supervisor so the hook's external arm is observable without a
// real worker fork (and so `deepConfigBlockFor` is reached + asserted).
const dispatchSpy = vi.fn(() => Promise.resolve());
vi.mock('../dispatch-external-tool-command.js', () => ({
  dispatchExternalToolCommand: (args: unknown) => dispatchSpy(args),
}));

afterEach(() => {
  dispatchSpy.mockClear();
});

const TOOL_ID = '11111111-1111-1111-1111-111111111111';
const TOOL_NAME = 'demo';

function makeTool(): Tool {
  return {
    identity: { name: TOOL_NAME },
    metadata: { id: TOOL_ID, name: TOOL_NAME },
  } as unknown as Tool;
}

function makeCtx(): ToolCliContext {
  return {} as unknown as ToolCliContext;
}

function externalProvenance(): ToolProvenance {
  return {
    source: 'installed',
    id: TOOL_NAME,
    stableId: TOOL_ID,
    version: '1.0.0',
    manifestHash: 'h',
  };
}

function manifest(overrides: Partial<ToolPluginManifest>): ToolPluginManifest {
  return {
    kind: 'tool',
    apiVersion: 1,
    id: TOOL_NAME,
    identity: { name: TOOL_NAME },
    name: 'Demo',
    version: '1.0.0',
    commands: [],
    ...overrides,
  } as unknown as ToolPluginManifest;
}

describe('buildMaybeDispatchExternal — provenance gate', () => {
  it('returns false (in-process) for bundled provenance', async () => {
    const scope = new RunScope({
      toolProvenance: [{ ...externalProvenance(), source: 'bundled' }],
    });
    const hook = buildMaybeDispatchExternal(makeTool(), makeCtx());

    const handled = await runWithScopeSync(scope, () => hook('run', {}, []));
    expect(handled).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('returns false when no provenance is recorded (the `?? []` fallback, L76)', async () => {
    // Run OUTSIDE any entered scope: `currentScope()` is undefined, so
    // `currentScope()?.toolProvenance ?? []` takes the `?? []` arm.
    const hook = buildMaybeDispatchExternal(makeTool(), makeCtx());
    const handled = await hook('run', {}, []);
    expect(handled).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe('buildMaybeDispatchExternal — external arm forks + forwards config', () => {
  it('forks the worker and forwards the namespaced raw config block', async () => {
    const scope = new RunScope({
      toolProvenance: [externalProvenance()],
      toolManifests: [manifest({ stableId: TOOL_ID, config: { namespace: 'demo', schema: {} } })],
    });
    // `configDocument` is an Object.assign'd slot (the bootstrap sets it after
    // construction; the constructor does not read it), so mirror that here.
    Object.assign(scope, { configDocument: { demo: { level: 'strict' } } });
    const ctx = makeCtx();
    const hook = buildMaybeDispatchExternal(makeTool(), ctx);

    const handled = await runWithScope(scope, () => hook('run', { x: 1 }, ['a']));
    expect(handled).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: expect.objectContaining({ source: 'installed' }),
        commandName: 'run',
        opts: { x: 1 },
        positionals: ['a'],
        ctx,
        config: { level: 'strict' },
      }),
    );
  });

  it('falls back from a non-matching stableId to the human-name manifest match (L43)', async () => {
    // The first manifest declares a stableId that does NOT equal the tool id, so
    // the stable-id `find` predicate's `&& m.stableId === tool.metadata.id` arm
    // evaluates to false; resolution falls through to the `m.id === name` match.
    const otherId = '99999999-9999-9999-9999-999999999999';
    const scope = new RunScope({
      toolProvenance: [externalProvenance()],
      toolManifests: [
        manifest({ id: TOOL_NAME, stableId: otherId, config: { namespace: 'demo', schema: {} } }),
      ],
    });
    Object.assign(scope, { configDocument: { demo: { matched: 'by-name' } } });
    const hook = buildMaybeDispatchExternal(makeTool(), makeCtx());

    const handled = await runWithScope(scope, () => hook('run', {}, []));
    expect(handled).toBe(true);
    // The name-matched manifest's namespace block was forwarded.
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ config: { matched: 'by-name' } }),
    );
  });

  it('forwards undefined config when the matched manifest declares no namespace', async () => {
    const scope = new RunScope({
      toolProvenance: [externalProvenance()],
      toolManifests: [manifest({ stableId: TOOL_ID })], // no `config`
    });
    Object.assign(scope, { configDocument: { demo: { ignored: true } } });
    const hook = buildMaybeDispatchExternal(makeTool(), makeCtx());

    await runWithScope(scope, () => hook('run', {}, []));
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ config: undefined }));
  });
});
