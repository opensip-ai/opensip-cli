/**
 * Phase 4 (release 2.8.0): `plugin list` surfaces the admitted-tool
 * provenance recorded this run. The provenance is read from the per-run
 * holder (set via setToolProvenanceForRun), NOT re-derived from disk, and
 * is carried on the `plugin-list` result so `--json` serializes the full
 * ToolProvenance (source + manifestHash) for every admitted tool.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { setToolProvenanceForRun } from '../cli-context.js';
import { pluginList } from '../commands/plugin.js';

import type { ToolProvenance } from '@opensip-cli/contracts';

const FIT_PROVENANCE: ToolProvenance = {
  source: 'bundled',
  id: 'fit',
  version: '2.8.0',
  packageName: '@opensip-cli/fitness',
  resolvedPath: '/pkgs/fitness',
  manifestHash: 'fit00000000000000000000000000000000000000000000000000000000fit0',
};

const GRAPH_PROVENANCE: ToolProvenance = {
  source: 'installed',
  id: 'graph',
  version: '2.8.0',
  packageName: '@opensip-cli/graph',
  resolvedPath: '/pkgs/graph',
  manifestHash: 'graph0000000000000000000000000000000000000000000000000000000gr',
};

afterEach(() => {
  // Reset the per-run holder so leakage can't mask a regression.
  setToolProvenanceForRun([]);
});

describe('plugin list — tool provenance', () => {
  it('carries the per-run provenance on the plugin-list result', async () => {
    setToolProvenanceForRun([FIT_PROVENANCE, GRAPH_PROVENANCE]);

    const result = await pluginList('/no/such/project', []);

    expect(result.type).toBe('plugin-list');
    if (result.type !== 'plugin-list') throw new Error('unreachable');
    expect(result.toolProvenance).toEqual([FIT_PROVENANCE, GRAPH_PROVENANCE]);
  });

  it('--json output includes source + manifestHash for the bundled tools', async () => {
    setToolProvenanceForRun([FIT_PROVENANCE, GRAPH_PROVENANCE]);

    const result = await pluginList('/no/such/project', []);
    // Round-trip through the exact serializer `mountResultCommand`'s --json
    // branch uses, then re-parse, to assert the wire shape a machine sees.
    // NB: intentionally exercises the JSON.stringify --json path, not a deep
    // clone — this is the exact bytes a machine consumer sees.
    const json = JSON.parse(JSON.stringify(result, null, 2)) as typeof result;

    if (json.type !== 'plugin-list') throw new Error('unreachable');
    expect(json.toolProvenance).toHaveLength(2);
    const fit = json.toolProvenance.find((p) => p.id === 'fit');
    expect(fit?.source).toBe('bundled');
    expect(fit?.manifestHash).toBe(FIT_PROVENANCE.manifestHash);
    expect(fit?.packageName).toBe('@opensip-cli/fitness');
  });

  it('is an empty array when no tools were admitted (no bootstrap)', async () => {
    setToolProvenanceForRun([]);

    const result = await pluginList('/no/such/project', []);

    if (result.type !== 'plugin-list') throw new Error('unreachable');
    expect(result.toolProvenance).toEqual([]);
    // Additive: existing fields unchanged.
    expect(result.plugins).toEqual([]);
    expect(result.totalCount).toBe(0);
  });
});
