/**
 * tool-provenance — unit coverage for the shared provenance classifier + the
 * ADR-0054 M4-F host/worker hook-execution gate.
 */

import { type Tool, type ToolProvenance } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import {
  IN_TOOL_WORKER_ENV,
  isExternalHookHostSkipActive,
  isExternalToolProvenance,
  provenanceRecordFor,
  provenanceSourceFor,
  shouldRunHookInHost,
} from '../bootstrap/tool-provenance.js';

function tool(id: string, name?: string): Tool {
  return {
    metadata: { id, name: name ?? id, version: '0.0.0', description: id },
    commandSpecs: [],
  };
}

function prov(
  over: Partial<ToolProvenance> & Pick<ToolProvenance, 'source' | 'id'>,
): ToolProvenance {
  return { version: '0.0.0', manifestHash: 'h', ...over };
}

describe('provenanceSourceFor / isExternalToolProvenance', () => {
  it('matches by stableId (UUID → metadata.id) first', () => {
    const t = tool('uuid-1', 'human');
    const p = [prov({ source: 'installed', id: 'human', stableId: 'uuid-1' })];
    expect(provenanceSourceFor(t, p)).toBe('installed');
    expect(isExternalToolProvenance(t, p)).toBe(true);
  });

  it('falls back to the human key (ToolProvenance.id → metadata.name)', () => {
    const t = tool('uuid-2', 'fit');
    const p = [prov({ source: 'bundled', id: 'fit' })];
    expect(provenanceSourceFor(t, p)).toBe('bundled');
    expect(isExternalToolProvenance(t, p)).toBe(false);
  });

  it('treats a tool with NO recorded provenance as bundled (trusted/unknown path)', () => {
    const t = tool('unknown');
    expect(provenanceSourceFor(t, [])).toBe('bundled');
    expect(isExternalToolProvenance(t, [])).toBe(false);
  });

  it('provenanceRecordFor returns the full record (or undefined)', () => {
    const t = tool('uuid-3', 'ext');
    const rec = prov({
      source: 'project-local',
      id: 'ext',
      stableId: 'uuid-3',
    });
    expect(provenanceRecordFor(t, [rec])).toBe(rec);
    expect(provenanceRecordFor(tool('other'), [rec])).toBeUndefined();
  });
});

describe('isExternalHookHostSkipActive', () => {
  it('is ACTIVE in the host (flag unset) and INACTIVE inside a worker (flag = 1)', () => {
    expect(isExternalHookHostSkipActive({})).toBe(true);
    expect(isExternalHookHostSkipActive({ [IN_TOOL_WORKER_ENV]: '1' })).toBe(false);
    // Any other value is treated as "not the worker" (host-skip active).
    expect(isExternalHookHostSkipActive({ [IN_TOOL_WORKER_ENV]: '0' })).toBe(true);
  });
});

describe('shouldRunHookInHost (the M4-F gate)', () => {
  const bundled = tool('graph', 'graph');
  const external = tool('ext', 'ext');
  const provenance = [
    prov({ source: 'bundled', id: 'graph' }),
    prov({ source: 'installed', id: 'ext' }),
  ];

  it('bundled → always runs in-host', () => {
    expect(shouldRunHookInHost(bundled, provenance, {})).toBe(true);
    expect(shouldRunHookInHost(bundled, provenance, { [IN_TOOL_WORKER_ENV]: '1' })).toBe(true);
  });

  it('external + host (skip active) → does NOT run in-host', () => {
    expect(shouldRunHookInHost(external, provenance, {})).toBe(false);
  });

  it('external + worker (skip inactive) → DOES run (the worker is the isolation boundary)', () => {
    expect(shouldRunHookInHost(external, provenance, { [IN_TOOL_WORKER_ENV]: '1' })).toBe(true);
  });

  it('no provenance recorded → treated as bundled (runs in-host)', () => {
    expect(shouldRunHookInHost(tool('x'), [], {})).toBe(true);
  });
});
