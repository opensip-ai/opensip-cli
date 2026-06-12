/**
 * Unit tests for the `one-config-document` guardrail.
 *
 * Two layers:
 *  1. The pure `analyzeOneConfigDocument(content, filePath)` detector —
 *     a schema-validated block read (0 findings), a recipe-only projection
 *     (exempt), and a multi-knob hand-projection (flagged).
 *  2. The full `analyzeAll` over a fake in-memory `FileAccessor` — proves the
 *     self-targeting (only tool-engine files are inspected) and that the
 *     compliant graph/sim loaders contribute 0 findings.
 */
import { describe, expect, it } from 'vitest';

import { analyzeAllOneConfigDocument, analyzeOneConfigDocument } from '../one-config-document.js';

import type { FileAccessor } from '@opensip-cli/fitness';

const GRAPH_CONFIG = 'packages/graph/engine/src/cli/graph-config.ts';
const SIM_CONFIG = 'packages/simulation/engine/src/cli/sim-config.ts';

/** The compliant graph loader: reads `doc.graph`, parses through a Zod schema. */
const COMPLIANT_GRAPH = `
const doc = readYamlFile(filePath)
const graphBlock = doc.graph
const parsed = GraphConfigSchema.strict().safeParse(graphBlock)
if (!parsed.success) return {}
return parsed.data
`;

/** The compliant sim recipe resolver: reads `doc.simulation`, projects ONLY recipe. */
const COMPLIANT_SIM_RECIPE = `
const doc = readYamlFile(filePath)
const block = doc.simulation
return typeof block.recipe === 'string' ? block.recipe : undefined
`;

/** A reintroduced hand-projection: reads `doc.graph`, projects many knobs, NO parse. */
const HAND_PROJECTION = `
const doc = readYamlFile(filePath)
const block = doc.graph
return {
  minDuplicateBodyLines: typeof block.minDuplicateBodyLines === 'number' ? block.minDuplicateBodyLines : undefined,
  cycleMinSize: typeof block.cycleMinSize === 'number' ? block.cycleMinSize : undefined,
}
`;

describe('analyzeOneConfigDocument (pure detector)', () => {
  it('returns 0 findings for a schema-validated block read', () => {
    expect(analyzeOneConfigDocument(COMPLIANT_GRAPH, GRAPH_CONFIG)).toEqual([]);
  });

  it('returns 0 findings for a recipe-only projection (ADR-0022 resolver)', () => {
    expect(analyzeOneConfigDocument(COMPLIANT_SIM_RECIPE, SIM_CONFIG)).toEqual([]);
  });

  it('flags a multi-knob hand-projection with no Zod parse', () => {
    const v = analyzeOneConfigDocument(HAND_PROJECTION, GRAPH_CONFIG);
    expect(v).toHaveLength(1);
    expect(v[0]?.type).toBe('one-config-document');
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain('graph');
  });

  it('flags even a single non-recipe knob projected without a parse', () => {
    const single = `
const doc = readYamlFile(filePath)
const block = doc.graph
return block.cycleMinSize
`;
    const v = analyzeOneConfigDocument(single, GRAPH_CONFIG);
    expect(v).toHaveLength(1);
  });

  it('ignores a `.graph` member read off a non-YAML object (e.g. scope.graph)', () => {
    const scopeRead = `
const rules = scope.graph?.rules.getAll() ?? []
return rules.map((r) => r.type)
`;
    expect(analyzeOneConfigDocument(scopeRead, GRAPH_CONFIG)).toEqual([]);
  });

  it('returns 0 findings for a non-tool-engine file', () => {
    expect(analyzeOneConfigDocument(HAND_PROJECTION, 'packages/cli/src/index.ts')).toEqual([]);
  });

  it('does not react to a read of a DIFFERENT namespace block', () => {
    const cliBlock = `
const doc = readYamlFile(filePath)
const block = doc.cli
return block.recipe
`;
    // graph engine path, but the block read is `doc.cli` — not graph's own namespace.
    expect(analyzeOneConfigDocument(cliBlock, GRAPH_CONFIG)).toEqual([]);
  });
});

/** Build a fake FileAccessor over an in-memory path→content map. */
function fakeAccessor(files: Record<string, string>): FileAccessor {
  return {
    paths: Object.keys(files),
    read: (p) => Promise.resolve(files[p] ?? ''),
    readMany: (ps) => Promise.resolve(new Map(ps.map((p) => [p, files[p] ?? '']))),
    readAll: () => Promise.resolve(new Map(Object.entries(files))),
  };
}

describe('analyzeAllOneConfigDocument (self-targeting over the file set)', () => {
  it('returns 0 findings when all tool loaders are compliant', async () => {
    const files = {
      [GRAPH_CONFIG]: COMPLIANT_GRAPH,
      [SIM_CONFIG]: COMPLIANT_SIM_RECIPE,
      'packages/cli/src/index.ts': HAND_PROJECTION, // non-engine — ignored
    };
    expect(await analyzeAllOneConfigDocument(fakeAccessor(files))).toEqual([]);
  });

  it('flags a reintroduced hand-projection in a tool engine', async () => {
    const files = {
      [GRAPH_CONFIG]: HAND_PROJECTION,
      [SIM_CONFIG]: COMPLIANT_SIM_RECIPE,
    };
    const v = await analyzeAllOneConfigDocument(fakeAccessor(files));
    expect(v).toHaveLength(1);
    expect(v[0]?.filePath).toBe(GRAPH_CONFIG);
  });
});
