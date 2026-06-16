/**
 * bind-tool-context — mount-time ownership guard for tool-scoped host planes.
 */

import { PluginIncompatibleError, type Tool, type ToolCliContext } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { bindToolCliContext, toolOwnedKeys } from '../bind-tool-context.js';

function makeTool(): Tool {
  return {
    metadata: {
      id: '00000000-0000-4000-8000-00000000abcd',
      name: 'simulation',
      version: '0.0.0',
      description: 'fixture',
    },
    commands: [{ name: 'sim', description: 'run simulation' }],
    sessionReplay: { tool: 'sim', replaySession: vi.fn() },
  };
}

function makeContext(): {
  readonly ctx: ToolCliContext;
  readonly calls: string[];
  readonly scopeReads: () => number;
} {
  const calls: string[] = [];
  let scopeReads = 0;
  const ctx = {
    get scope() {
      scopeReads++;
      return {} as ToolCliContext['scope'];
    },
    saveBaseline: vi.fn((tool: string) => {
      calls.push(`save:${tool}`);
      return Promise.resolve();
    }),
    compareBaseline: vi.fn((tool: string) => {
      calls.push(`compare:${tool}`);
      return Promise.resolve({ degraded: false, netNew: [], resolved: [] });
    }),
    exportBaselineSarif: vi.fn((tool: string) => {
      calls.push(`sarif:${tool}`);
      return Promise.resolve();
    }),
    exportBaselineFingerprints: vi.fn((tool: string) => {
      calls.push(`fingerprints:${tool}`);
      return Promise.resolve();
    }),
    toolState: {
      get: vi.fn((tool: string) => {
        calls.push(`state-get:${tool}`);
        return Promise.resolve(undefined);
      }),
      put: vi.fn((tool: string) => {
        calls.push(`state-put:${tool}`);
        return Promise.resolve();
      }),
      delete: vi.fn((tool: string) => {
        calls.push(`state-delete:${tool}`);
        return Promise.resolve();
      }),
      list: vi.fn((tool: string) => {
        calls.push(`state-list:${tool}`);
        return Promise.resolve([]);
      }),
    },
    hostPlanes: {
      governance: {
        getGovernanceState: vi.fn((tool: string) => {
          calls.push(`governance-get:${tool}`);
          return Promise.resolve(undefined);
        }),
        listForProject: vi.fn(() => Promise.resolve([])),
        queryAudit: vi.fn((tool: string) => {
          calls.push(`governance-audit:${tool}`);
          return Promise.resolve([]);
        }),
        recordInstallation: vi.fn((tool: string) => {
          calls.push(`governance-install:${tool}`);
          return Promise.resolve();
        }),
        recordApprovalDecision: vi.fn((tool: string) => {
          calls.push(`governance-approval:${tool}`);
          return Promise.resolve();
        }),
        setBlock: vi.fn((tool: string) => {
          calls.push(`governance-block:${tool}`);
          return Promise.resolve();
        }),
        checkAllowed: vi.fn((tool: string) => {
          calls.push(`governance-allowed:${tool}`);
          return Promise.resolve(true);
        }),
      },
      audit: {
        append: vi.fn((tool: string) => {
          calls.push(`audit-append:${tool}`);
          return Promise.resolve();
        }),
        query: vi.fn((tool: string) => {
          calls.push(`audit-query:${tool}`);
          return Promise.resolve([]);
        }),
      },
      entitlements: {
        check: vi.fn((tool: string) => {
          calls.push(`entitlements-check:${tool}`);
          return Promise.resolve({ entitled: true });
        }),
        recordUsage: vi.fn((tool: string) => {
          calls.push(`entitlements-usage:${tool}`);
          return Promise.resolve();
        }),
        getLicenseState: vi.fn((tool: string) => {
          calls.push(`entitlements-license:${tool}`);
          return Promise.resolve(undefined);
        }),
      },
    },
  } as unknown as ToolCliContext;
  return { ctx, calls, scopeReads: () => scopeReads };
}

describe('bindToolCliContext', () => {
  it('derives owned namespaces from stable id, human name, primary command, and replay key', () => {
    expect([...toolOwnedKeys(makeTool())].sort()).toEqual([
      '00000000-0000-4000-8000-00000000abcd',
      'sim',
      'simulation',
    ]);
  });

  it('preserves the lazy scope getter without reading it at bind time', () => {
    const { ctx, scopeReads } = makeContext();
    const bound = bindToolCliContext(makeTool(), ctx);

    expect(scopeReads()).toBe(0);
    void bound.scope;
    expect(scopeReads()).toBe(1);
  });

  it('allows baseline and state operations for the owning tool namespaces', async () => {
    const { ctx, calls } = makeContext();
    const bound = bindToolCliContext(makeTool(), ctx);

    await bound.saveBaseline('simulation', {});
    await bound.compareBaseline('sim', {});
    await bound.toolState.put('sim', 'cursor', {});
    await bound.toolState.list('00000000-0000-4000-8000-00000000abcd');

    expect(calls).toEqual([
      'save:simulation',
      'compare:sim',
      'state-put:sim',
      'state-list:00000000-0000-4000-8000-00000000abcd',
    ]);
  });

  it('rejects cross-tool baseline and state operations before persistence', () => {
    const { ctx } = makeContext();
    const bound = bindToolCliContext(makeTool(), ctx);

    expect(() => bound.saveBaseline('graph', {})).toThrow(PluginIncompatibleError);
    expect(() => bound.toolState.put('fitness', 'cursor', {})).toThrow(/namespace 'fitness'/);
  });

  it('rejects cross-tool host-plane operations', () => {
    const { ctx } = makeContext();
    const bound = bindToolCliContext(makeTool(), ctx);

    expect(() => bound.hostPlanes?.audit?.append('graph', {})).toThrow(PluginIncompatibleError);
    expect(() => bound.hostPlanes?.entitlements?.check('fitness')).toThrow(/namespace 'fitness'/);
  });

  it('keeps project-level host-plane methods that are not tool-keyed available', async () => {
    const { ctx } = makeContext();
    const bound = bindToolCliContext(makeTool(), ctx);

    await expect(bound.hostPlanes?.governance?.listForProject('/repo')).resolves.toEqual([]);
  });

  // Guards the hand-enumerated `wrapHostPlanes` shape: a method added to any host
  // plane must be re-listed there, or it silently drops off the bound context
  // (tools see `undefined`, and it bypasses the namespace guard). This parity
  // check fails the moment the source plane and the wrapper diverge.
  it('forwards every host-plane method present on the source context', () => {
    const { ctx } = makeContext();
    const bound = bindToolCliContext(makeTool(), ctx);

    for (const plane of ['governance', 'audit', 'entitlements'] as const) {
      const source = ctx.hostPlanes?.[plane];
      const wrapped = bound.hostPlanes?.[plane];
      expect(wrapped, `bound.hostPlanes.${plane} missing`).toBeDefined();
      for (const method of Object.keys(source as object)) {
        expect(
          typeof (wrapped as Record<string, unknown>)[method],
          `host plane '${plane}' method '${method}' not forwarded by wrapHostPlanes`,
        ).toBe('function');
      }
    }
  });
});
