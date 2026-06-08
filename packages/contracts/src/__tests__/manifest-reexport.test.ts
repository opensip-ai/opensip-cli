/**
 * Verifies the release-2.8.0 manifest/epoch/compatibility surface is
 * re-exported from the contracts barrel (defined in @opensip-tools/core).
 */

import { describe, expect, it } from 'vitest';

import {
  PLUGIN_API_VERSION,
  checkCompatibility,
  type CompatibilityVerdict,
  type ToolCommandManifest,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolSource,
} from '../index.js';

describe('contracts manifest re-export', () => {
  it('re-exports the epoch + compatibility gate as runtime values', () => {
    expect(PLUGIN_API_VERSION).toBe(1);
    // 3.0.0: a missing apiVersion is incompatible (the grace window ended).
    expect(checkCompatibility(undefined).kind).toBe('incompatible');
    expect(checkCompatibility(PLUGIN_API_VERSION)).toEqual({ kind: 'compatible' });
    expect(checkCompatibility(PLUGIN_API_VERSION + 1).kind).toBe('incompatible');
  });

  it('re-exports the manifest/provenance types (compile-time shape check)', () => {
    const command: ToolCommandManifest = { name: 'fit', description: 'Run fitness checks' };
    const manifest: ToolPluginManifest = {
      kind: 'tool',
      id: 'fitness',
      name: 'Fitness',
      version: '2.8.0',
      apiVersion: PLUGIN_API_VERSION,
      commands: [command],
    };
    const source: ToolSource = 'bundled';
    const provenance: ToolProvenance = {
      source,
      id: manifest.id,
      version: manifest.version,
      manifestHash: 'deadbeef',
    };
    const verdict: CompatibilityVerdict = checkCompatibility(manifest.apiVersion);

    expect(manifest.commands[0]?.name).toBe('fit');
    expect(provenance.source).toBe('bundled');
    expect(verdict.kind).toBe('compatible');
  });
});
