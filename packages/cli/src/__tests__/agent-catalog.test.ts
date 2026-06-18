/**
 * `agent-catalog` — the self-describing machine surface for AI agents. Both
 * entry points are pure (no scope, no I/O), so they unit-test directly; the
 * command was previously only exercised via the subprocess surface, which is
 * coverage-invisible.
 */

import { describe, expect, it } from 'vitest';

import { buildAgentCatalog, executeAgentCatalog } from '../commands/agent-catalog.js';

describe('buildAgentCatalog', () => {
  it('returns a stable, fully-populated catalog', () => {
    const c = buildAgentCatalog();
    expect(c.version).toBe('1.0.0');
    expect(c.description).toMatch(/AI agents/i);
    // Every documented entry point carries at least one example.
    expect(c.entryPoints.length).toBeGreaterThanOrEqual(5);
    for (const e of c.entryPoints) {
      expect(e.command).toBeTruthy();
      expect(e.description).toBeTruthy();
      expect(e.examples.length).toBeGreaterThan(0);
    }
    expect(c.entryPoints.map((e) => e.command)).toEqual(
      expect.arrayContaining(['fit', 'graph', 'sessions list', 'sessions show', 'agent-catalog']),
    );
  });

  // tool-command-surface-taxonomy Task 4.5 — the catalog is grouped by tier and
  // never surfaces a Tier-3 internal command.
  describe('command taxonomy — tiered + no Tier-3 leakage', () => {
    /** The Tier-3 internal command-name shapes that must never be catalogued. */
    const INTERNAL_RE = /(?:-run-worker|-shard-worker|-equivalence-check)\b/;

    it('annotates every entry point with a non-internal taxonomy tier', () => {
      const c = buildAgentCatalog();
      for (const e of c.entryPoints) {
        // Task 1.4 grouped the surface by tier; each entry carries the predictable
        // Tier-1 (platform) / Tier-2 (tool) shape — and NEVER 'internal'.
        expect(e.tier, `entry '${e.command}' must declare a tier`).toBeDefined();
        expect(['platform', 'tool']).toContain(e.tier);
        expect(e.tier).not.toBe('internal');
      }
      // The catalog exposes both tiers (it is genuinely grouped, not all-one-tier).
      const tiers = new Set(c.entryPoints.map((e) => e.tier));
      expect(tiers.has('platform')).toBe(true);
      expect(tiers.has('tool')).toBe(true);
    });

    it('fit/graph are tool-tier; the host commands are platform-tier', () => {
      const c = buildAgentCatalog();
      const tierOf = (command: string) => c.entryPoints.find((e) => e.command === command)?.tier;
      expect(tierOf('fit')).toBe('tool');
      expect(tierOf('graph')).toBe('tool');
      expect(tierOf('sessions list')).toBe('platform');
      expect(tierOf('sessions show')).toBe('platform');
      expect(tierOf('agent-catalog')).toBe('platform');
    });

    it('no entry point or common pattern references an internal command name', () => {
      const c = buildAgentCatalog();
      for (const e of c.entryPoints) {
        expect(INTERNAL_RE.test(e.command), `entry '${e.command}' must not be internal`).toBe(
          false,
        );
        for (const ex of e.examples) {
          expect(INTERNAL_RE.test(ex), `example '${ex}' must not name an internal command`).toBe(
            false,
          );
        }
      }
      for (const p of c.commonPatterns) {
        expect(INTERNAL_RE.test(p.example), `pattern '${p.example}' must not be internal`).toBe(
          false,
        );
      }
    });

    it('does not advertise the deprecated flat export verbs as entry points', () => {
      const c = buildAgentCatalog();
      const commands = c.entryPoints.map((e) => e.command);
      for (const deprecated of [
        'sarif-export',
        'catalog-export',
        'graph-baseline-export',
        'fit-baseline-export',
      ]) {
        expect(commands, `deprecated '${deprecated}' must not be an entry point`).not.toContain(
          deprecated,
        );
      }
    });
  });

  it('describes the common agent patterns and output shapes', () => {
    const c = buildAgentCatalog();
    expect(c.commonPatterns.length).toBeGreaterThan(0);
    for (const p of c.commonPatterns) {
      expect(p.name).toBeTruthy();
      expect(p.example).toMatch(/^opensip /);
    }
    expect(c.outputShapes.signalEnvelope).toMatch(/SignalEnvelope|schemaVersion/);
    expect(c.outputShapes.sessionReplay).toMatch(/fidelity/);
    expect(c.outputShapes.history).toMatch(/history/);
    expect(c.notes.length).toBeGreaterThan(0);
  });
});

describe('executeAgentCatalog', () => {
  it('wraps the full catalog in a machine result under --json', () => {
    const out = executeAgentCatalog({ json: true });
    expect(out.type).toBe('agent-catalog');
    expect(out).toHaveProperty('catalog');
    const { catalog } = out as { catalog: ReturnType<typeof buildAgentCatalog> };
    expect(catalog).toEqual(buildAgentCatalog());
  });

  it('returns a concise text summary in human mode (no --json)', () => {
    const out = executeAgentCatalog();
    expect(out.type).toBe('text-lines');
    const lines = (out as { lines: string[] }).lines;
    expect(lines[0]).toMatch(/Agent Catalog/);
    // Each common pattern surfaces as a bullet; key entry points are summarized.
    expect(lines.some((l) => l.includes('•'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Key entry points:'))).toBe(true);
  });

  it('defaults to the human summary when given no options', () => {
    expect(executeAgentCatalog({}).type).toBe('text-lines');
  });
});
