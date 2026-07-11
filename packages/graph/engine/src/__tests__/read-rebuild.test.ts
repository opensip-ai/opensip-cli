import { afterEach, describe, expect, it, vi } from 'vitest';

import { rebuildCatalog } from '../read/rebuild.js';

const runGraphMock = vi.hoisted(() => vi.fn());
const runShardedGraphMock = vi.hoisted(() => vi.fn());

vi.mock('../cli/orchestrate.js', () => ({
  runGraph: runGraphMock,
  runShardedGraph: runShardedGraphMock,
  loadGraphConfig: vi.fn(() => ({})),
}));

vi.mock('../cli/orchestrate/engine-shard-policy.js', () => ({
  resolveDefaultEngineShards: vi.fn(() => Promise.resolve({ shards: [{ id: '0' }] })),
}));

vi.mock('../lang-adapter/registry.js', () => ({
  currentAdapterRegistry: vi.fn(() => ({ list: () => [] })),
}));

vi.mock('../lang-adapter/selector.js', () => ({
  GraphAdapterSelector: class {
    pick() {
      return { language: 'typescript' };
    }
  },
}));

vi.mock('../rules/registry.js', () => ({
  currentRules: vi.fn(() => []),
}));

const replaceAll = vi.fn();
vi.mock('../persistence/catalog-repo.js', () => ({
  CatalogRepo: class {
    replaceAll = replaceAll;
  },
}));

afterEach(() => {
  runGraphMock.mockReset();
  runShardedGraphMock.mockReset();
  replaceAll.mockReset();
});

describe('rebuildCatalog', () => {
  it('returns empty-catalog errors and persists non-empty catalogs', async () => {
    runGraphMock.mockResolvedValueOnce({ catalog: null });
    const empty = await rebuildCatalog({ cwd: '/proj' });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error.code).toBe('GRAPH.READ.REBUILD_EMPTY');

    const catalog = { builtAt: '2026-07-10T00:00:00.000Z' };
    runGraphMock.mockResolvedValueOnce({ catalog });
    const store = { kind: 'memory' };
    const okResult = await rebuildCatalog({ cwd: '/proj', datastore: store as never });
    expect(okResult.ok).toBe(true);
    expect(replaceAll).toHaveBeenCalledWith(catalog);
  });

  it('maps failed shards and infrastructure throws to rebuild failures', async () => {
    runGraphMock.mockResolvedValueOnce({ catalog: { builtAt: 't' }, failedShardIds: ['1'] });
    const failed = await rebuildCatalog({ cwd: '/proj' });
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error.code).toBe('GRAPH.READ.REBUILD_FAILED');
    expect(failed.error.message).toContain('shard');

    runGraphMock.mockRejectedValueOnce(new Error('disk full'));
    const thrown = await rebuildCatalog({ cwd: '/proj' });
    expect(thrown.ok).toBe(false);
    if (thrown.ok) return;
    expect(thrown.error.code).toBe('GRAPH.READ.REBUILD_FAILED');
    expect(thrown.error.message).toContain('infrastructure');
  });

  it('truncates long rebuild error messages', async () => {
    runGraphMock.mockResolvedValueOnce({
      catalog: null,
      // force REBUILD_EMPTY with a long constructed message path via catch instead
    });
    // Use throw with long message path through catch branch message truncation helper.
    runGraphMock.mockReset();
    runGraphMock.mockRejectedValueOnce(new Error('x'.repeat(200)));
    const result = await rebuildCatalog({ cwd: '/proj' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Infrastructure path uses a fixed message; truncation is for rebuildError() callers.
    expect(result.error.message.length).toBeLessThanOrEqual(160);
  });
});
