/**
 * Tool contract conformance test for fitnessTool.
 *
 * Mirrors the graph + simulation tests: catches version-drift between
 * `metadata.version` and package.json. Before tools/lib/package-version
 * existed, both fields were hardcoded literals that drifted silently
 * across releases.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveToolHooks } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { fitnessTool } from '../tool.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(resolve(HERE, '../../package.json'), 'utf8')) as {
  version: string;
};

describe('fitnessTool contract conformance', () => {
  it("metadata.name is the canonical identity 'fitness'; id is the stable UUID", () => {
    expect(fitnessTool.identity).toEqual({
      name: 'fitness',
      aliases: ['fit'],
      layoutKey: 'fit',
    });
    expect(fitnessTool.metadata.name).toBe('fitness');
    expect(fitnessTool.metadata.id).toBe('afd68bd3-ff3c-4935-a5b6-76d8fc7a5224');
    expect(fitnessTool.pluginLayout?.domain).toBe('fit');
    expect(resolveToolHooks(fitnessTool).sessionReplay?.tool).toBe('fit');
  });

  it('metadata.version matches package.json', () => {
    expect(fitnessTool.metadata.version).toBe(PKG.version);
  });

  it('metadata.description is non-empty', () => {
    expect(fitnessTool.metadata.description.length).toBeGreaterThan(0);
  });

  it('commands list includes fitness + the nested list/recipes/export children', () => {
    const names = (fitnessTool.commands ?? []).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['fitness', 'list', 'recipes', 'export']));
    // The legacy flat-root aliases are gone.
    expect(names).not.toContain('fit-list');
    expect(names).not.toContain('fit-recipes');
    expect(names).not.toContain('fit-baseline-export');
  });

  it("does not own the cross-tool 'report' command", () => {
    const names = (fitnessTool.commands ?? []).map((c) => c.name);
    expect(names).not.toContain('report');
    expect(names).not.toContain('dashboard');
  });

  it('contributes report data via the Tool.collectReportData seam', () => {
    expect(typeof resolveToolHooks(fitnessTool).collectReportData).toBe('function');
  });

  it('declares its command surface via commandSpecs (Phase 4), not register()', () => {
    expect(Array.isArray(fitnessTool.commandSpecs)).toBe(true);
    const specNames = (fitnessTool.commandSpecs ?? []).map((s) => s.name);
    expect(specNames).toEqual([
      'fitness',
      // Grouped Tier-2 children (the canonical `<tool> <verb>` grammar) —
      // name 'list' / 'recipes', parent 'fitness'.
      'list',
      'recipes',
      // Canonical nested export — name 'export', parent 'fitness'.
      'export',
      // [internal] headless run forked by the live view (ADR-0028).
      'fit-run-worker',
    ]);
    expect(fitnessTool.commandSpecs?.[0]?.aliases).toEqual(['fit']);
    for (const child of fitnessTool.commandSpecs?.filter((s) =>
      ['list', 'recipes', 'export'].includes(s.name),
    ) ?? []) {
      expect(child.parent).toBe('fitness');
    }
  });

  it('the nested list/recipes/export children declare no Commander aliases', () => {
    const byName = new Map((fitnessTool.commandSpecs ?? []).map((s) => [s.name, s]));
    expect(byName.get('list')?.aliases ?? []).toEqual([]);
    expect(byName.get('recipes')?.aliases ?? []).toEqual([]);
    expect(byName.get('export')?.aliases ?? []).toEqual([]);
  });
});
