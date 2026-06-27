/**
 * `agent-catalog` — the self-describing machine surface for AI agents. Both
 * entry points are pure (no scope, no I/O), so they unit-test directly; the
 * command was previously only exercised via the subprocess surface, which is
 * coverage-invisible.
 */

import { ToolRegistry } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { registerFirstPartyTools } from '../bootstrap/register-tools.js';
import { buildAgentCatalog, executeAgentCatalog } from '../commands/agent-catalog.js';

import type { Tool } from '@opensip-cli/core';

/**
 * @throws Error when a public tool command is missing from the agent catalog.
 */
function assertCatalogCoversTools(
  catalog: ReturnType<typeof buildAgentCatalog>,
  tools: ToolRegistry,
): void {
  const commands = new Set(catalog.entryPoints.map((entry) => entry.command));
  const missing = tools
    .list()
    .flatMap((tool) =>
      (tool.commandSpecs ?? [])
        .filter(
          (spec) =>
            spec.parent === undefined &&
            spec.visibility !== 'internal' &&
            !/(?:-run-worker|-shard-worker|-equivalence-check)\b/.test(spec.name),
        )
        .map((spec) => spec.name),
    )
    .filter((name) => !commands.has(name));
  if (missing.length > 0) {
    throw new Error(`agent-catalog missing public tool entry point(s): ${missing.join(', ')}`);
  }
}

async function makeRegistry(): Promise<ToolRegistry> {
  const tools = new ToolRegistry();
  await registerFirstPartyTools(tools);
  tools.register({
    identity: { name: 'third-party-tool' },
    metadata: {
      id: 'third-party-tool',
      name: 'third-party-tool',
      version: '0.0.0',
      description: 'fixture third-party tool',
    },
    commandSpecs: [
      {
        name: 'third-party-tool',
        description: 'run the third-party tool',
        output: 'command-result',
        handler: () => ({ type: 'text-lines', lines: ['ok'] }),
      },
      {
        name: 'third-party-tool-worker',
        description: '[internal] worker',
        output: 'raw-stream',
        rawStreamReason: 'worker-ipc',
        visibility: 'internal',
        handler: () => undefined,
      },
    ],
  } satisfies Tool);
  return tools;
}

describe('buildAgentCatalog', () => {
  it('returns a stable, fully-populated catalog from the live registry', async () => {
    const tools = await makeRegistry();
    const c = buildAgentCatalog({ tools });
    expect(c.version).toBe('1.0.0');
    expect(c.description).toMatch(/AI agents/i);
    // Every documented entry point carries at least one example.
    expect(c.entryPoints.length).toBeGreaterThanOrEqual(6);
    for (const e of c.entryPoints) {
      expect(e.command).toBeTruthy();
      expect(e.description).toBeTruthy();
      expect(e.examples.length).toBeGreaterThan(0);
    }
    expect(c.entryPoints.map((e) => e.command)).toEqual(
      expect.arrayContaining([
        'fitness',
        'graph',
        'simulation',
        'yagni',
        'third-party-tool',
        'sessions list',
        'sessions show',
        'agent-catalog',
      ]),
    );
    assertCatalogCoversTools(c, tools);
  });

  // tool-command-surface-taxonomy Task 4.5 — the catalog is grouped by tier and
  // never surfaces a Tier-3 internal command.
  describe('command taxonomy — tiered + no Tier-3 leakage', () => {
    /** The Tier-3 internal command-name shapes that must never be catalogued. */
    const INTERNAL_RE = /(?:-run-worker|-shard-worker|-equivalence-check)\b/;

    it('annotates every entry point with a non-internal taxonomy tier', async () => {
      const c = buildAgentCatalog({ tools: await makeRegistry() });
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

    it('fit/graph are tool-tier; the host commands are platform-tier', async () => {
      const c = buildAgentCatalog({ tools: await makeRegistry() });
      const tierOf = (command: string) => c.entryPoints.find((e) => e.command === command)?.tier;
      expect(tierOf('fitness')).toBe('tool');
      expect(tierOf('graph')).toBe('tool');
      expect(tierOf('sessions list')).toBe('platform');
      expect(tierOf('sessions show')).toBe('platform');
      expect(tierOf('agent-catalog')).toBe('platform');
    });

    it('no entry point or common pattern references an internal command name', () => {
      const c = buildAgentCatalog({ tools: new ToolRegistry() });
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

    it('does not advertise the removed flat export verbs as entry points', () => {
      const c = buildAgentCatalog({ tools: new ToolRegistry() });
      const commands = c.entryPoints.map((e) => e.command);
      for (const removed of [
        'sarif-export',
        'catalog-export',
        'graph-baseline-export',
        'fit-baseline-export',
      ]) {
        expect(commands, `removed '${removed}' must not be an entry point`).not.toContain(removed);
      }
    });
  });

  it('describes the common agent patterns and output shapes', () => {
    const c = buildAgentCatalog({ tools: new ToolRegistry() });
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

  it('surfaces agent recipes and the read-latest-result workflow', async () => {
    const c = buildAgentCatalog({ tools: await makeRegistry() });
    expect(c.commonPatterns.some((p) => p.name.toLowerCase().includes('read-latest'))).toBe(true);
    expect(c.commonPatterns.some((p) => p.example.includes('agent-fast'))).toBe(true);
    expect(c.notes.some((n) => n.includes('agent-fast'))).toBe(true);
    expect(c.notes.some((n) => n.includes('graph impact'))).toBe(true);
  });
});

describe('executeAgentCatalog', () => {
  it('wraps the full catalog in a machine result under --json', async () => {
    const tools = await makeRegistry();
    const out = executeAgentCatalog({ json: true, tools });
    expect(out.type).toBe('agent-catalog');
    expect(out).toHaveProperty('catalog');
    const { catalog } = out as {
      catalog: ReturnType<typeof buildAgentCatalog>;
    };
    expect(catalog).toEqual(buildAgentCatalog({ tools }));
  });

  it('returns a concise text summary in human mode (no --json)', async () => {
    const out = executeAgentCatalog({ tools: await makeRegistry() });
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
