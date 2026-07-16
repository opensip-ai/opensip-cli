import { describe, expect, it } from 'vitest';

import { filterRuntimeSnapshot, groupRuntimeNodes } from '../runtime-wiring-filter.js';

import type { RuntimeWiringEdge, RuntimeWiringNode } from '../runtime-wiring-read-port.js';

function node(
  overrides: Partial<RuntimeWiringNode> & Pick<RuntimeWiringNode, 'id' | 'kind' | 'label'>,
): RuntimeWiringNode {
  return {
    source: 'command-spec',
    ...overrides,
  };
}

function edge(
  overrides: Partial<RuntimeWiringEdge> &
    Pick<RuntimeWiringEdge, 'from' | 'to' | 'kind' | 'source'>,
): RuntimeWiringEdge {
  return {
    confidence: 'high',
    staticBridge: 'not-applicable',
    ...overrides,
  };
}

const snapshot = {
  nodes: [
    node({ id: 'tool:fit', kind: 'tool', label: 'fit', tool: 'fit', provenanceSource: 'bundled' }),
    node({
      id: 'command:fit:list',
      kind: 'command',
      label: 'list',
      tool: 'fit',
      commandPath: 'fit list',
      owner: 'tool',
    }),
    node({
      id: 'handler:fit:list',
      kind: 'handler',
      label: 'runFitList',
      tool: 'fit',
      commandPath: 'fit list',
    }),
    node({
      id: 'mount:fit:list',
      kind: 'host-mount',
      label: 'list',
      tool: 'fit',
      commandPath: 'fit list',
    }),
    node({
      id: 'tool:graph',
      kind: 'tool',
      label: 'graph',
      tool: 'graph',
      provenanceSource: 'installed',
    }),
    node({
      id: 'command:graph:export',
      kind: 'command',
      label: 'export',
      tool: 'graph',
      commandPath: 'graph export',
      owner: 'tool',
    }),
    node({
      id: 'command:graph:nested',
      kind: 'command',
      label: 'nested',
      tool: 'graph',
      commandPath: 'graph nested',
      owner: 'tool',
    }),
    node({ id: 'prov:bundled', kind: 'provenance', label: 'bundled', provenanceSource: 'bundled' }),
  ],
  edges: [
    edge({
      from: 'tool:fit',
      to: 'command:fit:list',
      kind: 'registry-owns-command',
      source: 'registry',
    }),
    edge({
      from: 'command:fit:list',
      to: 'mount:fit:list',
      kind: 'host-mounts-command',
      source: 'host-contract',
    }),
    edge({
      from: 'mount:fit:list',
      to: 'handler:fit:list',
      kind: 'command-dispatches-handler',
      source: 'command-spec',
    }),
    edge({
      from: 'prov:bundled',
      to: 'tool:fit',
      kind: 'manifest-admits-tool',
      source: 'provenance',
    }),
    edge({
      from: 'tool:graph',
      to: 'command:graph:export',
      kind: 'registry-owns-command',
      source: 'registry',
    }),
    edge({
      from: 'command:graph:export',
      to: 'command:graph:nested',
      kind: 'command-nests-under',
      source: 'command-spec',
    }),
  ],
};

describe('filterRuntimeSnapshot', () => {
  it('returns all nodes when no filters are set', () => {
    const out = filterRuntimeSnapshot(snapshot, {}, undefined);
    expect(out.nodes).toHaveLength(snapshot.nodes.length);
    expect(out.edges.length).toBeGreaterThan(0);
  });

  it('filters by canonical tool without expanding nest closure', () => {
    const out = filterRuntimeSnapshot(snapshot, {}, 'fit');
    expect(out.nodes.every((n) => n.tool === 'fit' || n.kind === 'provenance')).toBe(true);
    expect(out.nodes.some((n) => n.id === 'command:fit:list')).toBe(true);
    expect(out.nodes.some((n) => n.id === 'command:graph:export')).toBe(false);
  });

  it('filters by provenanceSource to matching tools', () => {
    const out = filterRuntimeSnapshot(snapshot, { provenanceSource: 'bundled' }, undefined);
    expect(out.nodes.some((n) => n.tool === 'fit')).toBe(true);
    expect(out.nodes.some((n) => n.tool === 'graph')).toBe(false);
  });

  it('filters by command substring and retains nested/related graph', () => {
    const out = filterRuntimeSnapshot(snapshot, { command: 'list' }, undefined);
    expect(out.nodes.some((n) => n.id === 'command:fit:list')).toBe(true);
    expect(out.nodes.some((n) => n.id === 'handler:fit:list')).toBe(true);
    expect(out.nodes.some((n) => n.id === 'tool:fit')).toBe(true);
    expect(out.nodes.some((n) => n.id === 'command:graph:export')).toBe(false);
  });

  it('matches command path case-insensitively', () => {
    const out = filterRuntimeSnapshot(snapshot, { command: 'EXPORT' }, undefined);
    expect(out.nodes.some((n) => n.id === 'command:graph:export')).toBe(true);
    // Nest closure pulls nested command
    expect(out.nodes.some((n) => n.id === 'command:graph:nested')).toBe(true);
  });

  it('combines tool + command filters', () => {
    const out = filterRuntimeSnapshot(snapshot, { command: 'list' }, 'graph');
    expect(out.nodes).toHaveLength(0);
  });
});

describe('groupRuntimeNodes', () => {
  it('returns no groups for groupBy=none', () => {
    expect(groupRuntimeNodes(snapshot.nodes, 'none')).toEqual({ groupTruncated: false });
  });

  it('groups by tool with unattributed fallback', () => {
    const withUnattributed = [
      ...snapshot.nodes,
      node({ id: 'orphan', kind: 'command', label: 'x' }),
    ];
    const out = groupRuntimeNodes(withUnattributed, 'tool');
    expect(out.groupTruncated).toBe(false);
    expect(out.groups?.some((g) => g.key === 'fit')).toBe(true);
    expect(out.groups?.some((g) => g.key === 'unattributed')).toBe(true);
  });

  it('groups by owner and source', () => {
    const byOwner = groupRuntimeNodes(snapshot.nodes, 'owner');
    expect(byOwner.groups?.some((g) => g.key === 'tool' || g.key === 'unattributed')).toBe(true);
    const bySource = groupRuntimeNodes(snapshot.nodes, 'source');
    expect(bySource.groups?.length).toBeGreaterThan(0);
  });
});
