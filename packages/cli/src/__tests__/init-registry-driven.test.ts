/**
 * ADR-0038 enforcement guards — the registry-driven `init` contract.
 *
 * The byte-identical golden (`init-golden.test.ts`) proves the refactor is
 * behavior-preserving for the FIRST-PARTY tool set. These tests prove the
 * generalization the golden can't see:
 *
 *   1. an arbitrary fixture tool scaffolds through `init` with ZERO `packages/cli`
 *      change (the whole point of ADR-0038);
 *   2. a tool with no `pluginLayout` (graph) produces no directory;
 *   3. the scaffolded set equals the REGISTERED set, not a hardcoded fit/sim pair;
 *   4. stale-detection aggregates each tool's FULL id universe (not the
 *      per-context ids) — the high-risk surface flagged in Phase 1; and
 *   5. no fit/sim/checks/recipes/scenarios literal survives in `scaffold-writer.ts`.
 */

import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProjectPaths } from '@opensip-cli/core';
import { fitnessTool } from '@opensip-cli/fitness';
import { graphTool } from '@opensip-cli/graph';
import { simulationTool } from '@opensip-cli/simulation';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyFiles } from '../commands/init/file-classifier.js';
import { executeInit } from '../commands/init.js';

import type { ToolScaffold } from '../commands/shared.js';
import type { Tool } from '@opensip-cli/core';

/** Derive a `ToolScaffold` list from real tools, mirroring the host's aggregation. */
function scaffoldsFor(tools: readonly Tool[]): ToolScaffold[] {
  return tools
    .filter((t) => t.pluginLayout !== undefined)
    .map((t) => ({
      layout: t.pluginLayout!,
      scaffoldExamples: t.scaffoldExamples,
      stableExampleIds: t.stableExampleIds,
      scaffoldConfigBlock: t.scaffoldConfigBlock,
    }));
}

/** The pinned check id fitness embeds for a single language — from the tool itself. */
function pinnedCheckId(language: string): string {
  const files = fitnessTool.scaffoldExamples?.({ languages: [language] }) ?? [];
  const check = files.find((f) => f.filename.startsWith('example-check'));
  if (!check) throw new Error(`no example-check contribution for ${language}`);
  return check.stableId;
}

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-init-registry-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeArgs(toolScaffolds: ToolScaffold[], overrides: Record<string, unknown> = {}) {
  return {
    json: false,
    cwd: testDir,
    debug: false,
    language: ['typescript'],
    toolScaffolds,
    ...overrides,
  } as Parameters<typeof executeInit>[0];
}

describe('init — fixture tool scaffolds with no CLI change (ADR-0038)', () => {
  it("writes an arbitrary tool's example under its own pluginLayout domain", () => {
    // A fake tool the CLI has never heard of. Nothing in packages/cli references
    // 'toy' / 'rules' — the directory + bytes come entirely from this contribution.
    const toyScaffold: ToolScaffold = {
      layout: { domain: 'toy', userSubdirs: ['rules'] },
      scaffoldExamples: () => [
        { kind: 'rules', filename: 'example-rule.mjs', content: '// toy\n', stableId: 'toy-1' },
      ],
      stableExampleIds: () => ['toy-1'],
    };

    const result = executeInit(
      makeArgs([...scaffoldsFor([fitnessTool, simulationTool]), toyScaffold]),
    );
    expect(result.created).toBe(true);

    const rule = join(testDir, 'opensip-cli/toy/rules/example-rule.mjs');
    expect(existsSync(rule)).toBe(true);
    expect(readFileSync(rule, 'utf8')).toBe('// toy\n');
  });
});

describe('init — a tool with no pluginLayout produces no directory', () => {
  it('graph contributes nothing (no opensip-cli/graph/)', () => {
    // graphTool declares no pluginLayout, so scaffoldsFor() filters it out — the
    // dir must never appear even when graphTool is in the considered set.
    const result = executeInit(makeArgs(scaffoldsFor([fitnessTool, simulationTool, graphTool])));
    expect(result.created).toBe(true);
    expect(existsSync(join(testDir, 'opensip-cli/graph'))).toBe(false);
  });
});

describe('init — the scaffolded set equals the registered set', () => {
  it('with only fitness registered, fit/ exists and sim/ does not', () => {
    const result = executeInit(makeArgs(scaffoldsFor([fitnessTool])));
    expect(result.created).toBe(true);
    expect(existsSync(join(testDir, 'opensip-cli/fit/checks'))).toBe(true);
    // The load-bearing behavioral change: not a hardcoded fit/sim pair.
    expect(existsSync(join(testDir, 'opensip-cli/sim'))).toBe(false);
  });
});

function initTsOnly(): void {
  executeInit(makeArgs(scaffoldsFor([fitnessTool, simulationTool])));
}

describe('init — stale-detection over the aggregated full-language id universe', () => {
  it('flags example-check-<lang>.mjs for an un-detected language (filename branch)', () => {
    initTsOnly();
    // python ∉ the detected set (TS-only) but ∈ ALL_LANGUAGES → stale by filename.
    const stale = join(testDir, 'opensip-cli/fit/checks/example-check-python.mjs');
    writeFileSync(stale, '// drifted python example\n', 'utf8');

    const paths = resolveProjectPaths(testDir);
    const classified = classifyFiles(
      paths,
      ['typescript'],
      scaffoldsFor([fitnessTool, simulationTool]),
    );
    const entry = classified.find((f) => f.path === stale);
    expect(entry?.classification).toBe('stale-scaffolded');
  });

  it('flags a file embedding a pinned id for an un-detected language (UUID branch)', () => {
    initTsOnly();
    // A custom filename (no filename-pattern match) whose body carries the RUST
    // pinned id — caught only because the classifier aggregates the FULL id
    // universe (Σ stableExampleIds), not just the TS-context ids.
    const rustId = pinnedCheckId('rust');
    const stale = join(testDir, 'opensip-cli/fit/checks/my-thing.mjs');
    writeFileSync(stale, `// id: ${rustId}\n`, 'utf8');

    const paths = resolveProjectPaths(testDir);
    const classified = classifyFiles(
      paths,
      ['typescript'],
      scaffoldsFor([fitnessTool, simulationTool]),
    );
    expect(classified.find((f) => f.path === stale)?.classification).toBe('stale-scaffolded');
  });

  it('does NOT flag a detected-language id as stale', () => {
    initTsOnly();
    // TS id is in the CURRENT-config id set → excluded from the stale universe.
    // A drifted (non-byte-identical) file carrying it is custom, never stale.
    const tsId = pinnedCheckId('typescript');
    const custom = join(testDir, 'opensip-cli/fit/checks/my-ts-thing.mjs');
    writeFileSync(custom, `// id: ${tsId}\n// edited\n`, 'utf8');

    const paths = resolveProjectPaths(testDir);
    const classified = classifyFiles(
      paths,
      ['typescript'],
      scaffoldsFor([fitnessTool, simulationTool]),
    );
    expect(classified.find((f) => f.path === custom)?.classification).toBe('custom');
  });

  it('--keep preserves a stale-scaffolded file', () => {
    initTsOnly();
    const stale = join(testDir, 'opensip-cli/fit/checks/example-check-python.mjs');
    const body = '// drifted python example\n';
    writeFileSync(stale, body, 'utf8');

    executeInit(makeArgs(scaffoldsFor([fitnessTool, simulationTool]), { keep: true }));
    expect(existsSync(stale)).toBe(true);
    expect(readFileSync(stale, 'utf8')).toBe(body);
  });
});

describe('ADR-0038 grep guard — no tool literals in scaffold-writer.ts', () => {
  it('scaffold-writer.ts contains no quoted fit/sim/checks/recipes/scenarios literal', () => {
    // Backs ADR-0038's acceptance criterion: the directory layout must come from
    // each tool's pluginLayout, never a hardcoded tool/kind literal in the host.
    // Scoped to QUOTED literals so docstrings ("fit/sim") and the .runtime line pass.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../commands/init/scaffold-writer.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/['"](fit|sim|checks|recipes|scenarios)['"]/);
  });
});
