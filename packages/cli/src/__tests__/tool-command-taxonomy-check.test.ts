/**
 * Unit test for the project-local `tool-command-taxonomy` fitness check's pure
 * analysis function (`analyzeToolCommandTaxonomy`).
 *
 * tool-command-surface-taxonomy Task 4.2. The check's pure analyzer is the
 * dogfood-gate complement to the behaviour-parity snapshot: where the snapshot
 * pins the full runtime tree, THIS check asserts the SHAPE of the declared
 * command names a first-party tool registration file (`tool.ts`) carries. A
 * regression in the CHECK ITSELF (a rule going silently dormant, a path-gate
 * leak into adopter files) would let a real taxonomy violation through, so we
 * exercise each rule directly.
 *
 * Why the test lives here, not next to the `.mjs` check: project-local checks
 * under `opensip-cli/fit/checks/` are NOT covered by any vitest config (Phase 0
 * research found no `__tests__` there), so per the phase-file precedent (option
 * b) the unit test lives under the CLI package's test root and imports the pure
 * exported function across the repo-relative path. The `.mjs` only imports
 * `defineCheck` from `@opensip-cli/fitness` at module load, which resolves
 * through the workspace — so the import is side-effect-safe.
 *
 * The three rules and their two-stage activation (see the check's file header):
 *  - Rule A (no masquerading export verb): activates once a canonical `export`
 *    descriptor exists in the file; the EXISTING `sarif-export`/`catalog-export`
 *    bare verbs are documented legacy aliases (Phase 2 resolved decision) and are
 *    therefore exempt via `ALLOWED_LEGACY_NAMES`. See the dead-trigger note on the
 *    Rule A `describe` block.
 *  - Rule B (internal marker): activates once at least one descriptor in the file
 *    declares `visibility: 'internal'`; then EVERY worker name must be marked.
 *  - Rule C (verb shape): always active (warning) — a public descriptor name must
 *    be the bare verb, a tool-prefixed name, a `parent`-nested child, or an
 *    allowed legacy alias.
 */

import { describe, expect, it } from 'vitest';

// Repo-relative import of the project-local check's pure analyzer (it has no
// package export — see the file header for why the test lives here).
import { analyzeToolCommandTaxonomy } from '../../../../opensip-cli/fit/checks/tool-command-taxonomy.mjs';

/** A first-party tool-registration path that satisfies the check's path gate. */
const GRAPH_TOOL = '/repo/packages/graph/engine/src/tool.ts';
const FIT_TOOL = '/repo/packages/fitness/engine/src/tool.ts';

/** A `ToolCommandDescriptor` object literal as it appears in a real `tool.ts`. */
function descriptor(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([k, v]) => `  ${k}: '${v}',`)
    .join('\n');
  return `const NAME: ToolCommandDescriptor = {\n${body}\n};`;
}

describe('analyzeToolCommandTaxonomy — path gate (Step 4)', () => {
  it('returns [] for any file outside the first-party tool-registration scope', () => {
    const content = descriptor({ name: 'frobnicate', description: 'x' });
    // A non-tool.ts path — the gate makes the check inert in adopter repos and
    // on every other source file.
    expect(analyzeToolCommandTaxonomy(content, '/repo/packages/cli/src/index.ts')).toEqual([]);
    expect(analyzeToolCommandTaxonomy(content, '/repo/some/other/file.ts')).toEqual([]);
    // A tool.ts under a NON-first-party package segment is also out of scope.
    expect(analyzeToolCommandTaxonomy(content, '/repo/packages/audit/engine/src/tool.ts')).toEqual(
      [],
    );
  });

  it('engages for each first-party tool-registration path', () => {
    const content = descriptor({ name: 'frobnicate', description: 'x' });
    for (const path of [FIT_TOOL, GRAPH_TOOL, '/repo/packages/simulation/engine/src/tool.ts']) {
      expect(analyzeToolCommandTaxonomy(content, path).length).toBeGreaterThan(0);
    }
  });
});

describe('analyzeToolCommandTaxonomy — Rule A (no masquerading export verb) (Step 1)', () => {
  // Dead-trigger note (tool-command-surface-taxonomy Phase 2 resolved decision):
  // Rule A's masquerading regex matches ONLY `sarif-export`/`catalog-export`, and
  // BOTH are in the check's `ALLOWED_LEGACY_NAMES` exemption (they are documented
  // legacy aliases that coexist with the canonical `graph export`). So Rule A
  // never FIRES on a real name today; what we assert here is its OBSERVABLE
  // contract: the activation gate (`hasCanonicalExport`) and the legacy-alias
  // exemption both behave as the header documents. (The dead-trigger is flagged
  // for the Phase-2 owner — see the task report deviations.)

  it('does NOT flag an allow-listed bare export verb even with the canonical export present', () => {
    // graph declares the legacy flat `sarif-export` AND the canonical nested
    // `graph export` — the post-Phase-2 shape. The legacy alias is exempt.
    const content = [
      descriptor({ name: 'sarif-export', description: 'write SARIF' }),
      descriptor({ name: 'export', parent: 'graph', description: 'canonical' }),
    ].join('\n\n');
    const findings = analyzeToolCommandTaxonomy(content, GRAPH_TOOL);
    expect(findings.filter((f) => /masquerade/i.test(f.message))).toEqual([]);
  });

  it('is dormant when no canonical export descriptor exists (activation gate off)', () => {
    // Pre-Phase-2 shape: bare `sarif-export` with NO canonical `export` in the
    // file. Rule A must not fire (and the legacy name is an allowed alias under
    // Rule C, so the bare verb produces no finding at all).
    const content = descriptor({ name: 'sarif-export', description: 'write SARIF' });
    const findings = analyzeToolCommandTaxonomy(content, GRAPH_TOOL);
    expect(findings.filter((f) => /masquerade/i.test(f.message))).toEqual([]);
    // sarif-export is an allowed legacy alias, so Rule C is silent too.
    expect(findings).toEqual([]);
  });
});

describe('analyzeToolCommandTaxonomy — Rule B (internal marker) (Step 2)', () => {
  it('errors when a worker descriptor lacks visibility:internal but the marker convention is in use', () => {
    // `fit-run-worker` is missing the marker, but another worker in the file IS
    // marked — so the convention is in use and Rule B activates, catching the
    // unmarked worker.
    const content = [
      descriptor({ name: 'fit-run-worker', description: '[internal] worker' }),
      descriptor({ name: 'fit-shard-worker', visibility: 'internal', description: '[internal]' }),
    ].join('\n\n');
    const findings = analyzeToolCommandTaxonomy(content, FIT_TOOL);
    const ruleB = findings.filter((f) => /must declare visibility: 'internal'/.test(f.message));
    expect(ruleB).toHaveLength(1);
    expect(ruleB[0]?.severity).toBe('error');
    expect(ruleB[0]?.message).toContain('fit-run-worker');
  });

  it('produces no finding when the worker carries the visibility:internal marker', () => {
    const content = descriptor({
      name: 'fit-run-worker',
      visibility: 'internal',
      description: '[internal] worker',
    });
    expect(analyzeToolCommandTaxonomy(content, FIT_TOOL)).toEqual([]);
  });

  it('is dormant when NO descriptor in the file uses the marker (pre-Phase-1 shape)', () => {
    // A lone unmarked worker with no marker convention anywhere in the file: Rule
    // B has not activated, so the unmarked worker is tolerated (and internal
    // names are exempt from the Rule C verb-shape check).
    const content = descriptor({ name: 'fit-run-worker', description: '[internal] worker' });
    expect(analyzeToolCommandTaxonomy(content, FIT_TOOL)).toEqual([]);
  });

  it('also recognises graph-equivalence-check as an internal worker name', () => {
    // `graph-equivalence-check` is the non-`*-worker` internal name (the Phase 1
    // leak fix). Unmarked, with the convention in use elsewhere, Rule B fires.
    const content = [
      descriptor({ name: 'graph-equivalence-check', description: '[internal] gate' }),
      descriptor({ name: 'graph-run-worker', visibility: 'internal', description: '[internal]' }),
    ].join('\n\n');
    const ruleB = analyzeToolCommandTaxonomy(content, GRAPH_TOOL).filter((f) =>
      /must declare visibility: 'internal'/.test(f.message),
    );
    expect(ruleB).toHaveLength(1);
    expect(ruleB[0]?.message).toContain('graph-equivalence-check');
  });
});

describe('analyzeToolCommandTaxonomy — Rule C (verb shape) (Step 3)', () => {
  it('warns on a non-conforming public verb name', () => {
    const content = descriptor({ name: 'frobnicate', description: 'x' });
    const findings = analyzeToolCommandTaxonomy(content, GRAPH_TOOL);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
    expect(findings[0]?.message).toContain('frobnicate');
    expect(findings[0]?.message).toMatch(/does not fit the Tier-2 grammar/);
  });

  it('does NOT warn on the bare tool verb', () => {
    const content = descriptor({ name: 'graph', description: 'run graph' });
    expect(analyzeToolCommandTaxonomy(content, GRAPH_TOOL)).toEqual([]);
  });

  it('does NOT warn on a tool-prefixed grouped name', () => {
    const content = descriptor({ name: 'graph-lookup', description: 'look up a symbol' });
    expect(analyzeToolCommandTaxonomy(content, GRAPH_TOOL)).toEqual([]);
  });

  it('does NOT warn on a parent-nested child (the canonical <tool> <verb> grammar)', () => {
    // `parent: 'graph'` IS the grammar — a nested `graph export` / `graph list`.
    const content = descriptor({ name: 'list', parent: 'graph', description: 'list rules' });
    expect(analyzeToolCommandTaxonomy(content, GRAPH_TOOL)).toEqual([]);
  });

  it('does NOT warn on an allowed legacy alias', () => {
    const content = descriptor({ name: 'fit-baseline-export', description: 'export baseline' });
    expect(analyzeToolCommandTaxonomy(content, FIT_TOOL)).toEqual([]);
  });

  it('warns per-tool with the correct expected verb in the message', () => {
    // The expected bare verb is keyed off the package segment: fitness -> fit.
    const content = descriptor({ name: 'frobnicate', description: 'x' });
    const findings = analyzeToolCommandTaxonomy(content, FIT_TOOL);
    expect(findings[0]?.message).toContain("bare verb 'fit'");
  });
});
