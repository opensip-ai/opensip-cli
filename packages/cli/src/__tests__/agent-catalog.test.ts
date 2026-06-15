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
