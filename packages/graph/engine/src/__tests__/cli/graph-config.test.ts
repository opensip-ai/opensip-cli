/**
 * Loader for the `graph:` block of opensip-tools.config.yml.
 *
 * Validates that the rule knobs (notably minCrossPackageDuplicatePackages)
 * are read from the project config, and that every absence/malformed path
 * collapses permissively to `{}` (the rule then uses its in-rule default).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithScopeSync } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadGraphConfig } from '../../cli/graph-config.js';
import { makeGraphTestScope } from '../test-utils/with-graph-scope.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'graph-config-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeConfig(body: string): void {
  writeFileSync(join(workDir, 'opensip-tools.config.yml'), body, 'utf8');
}

describe('loadGraphConfig', () => {
  it('reads the graph rule knobs from a valid graph: block (strict, ADR-0023)', () => {
    writeConfig(
      [
        'graph:',
        '  minDuplicateBodyLines: 8',
        '  minDuplicateBodySize: 120',
        '  minCrossPackageDuplicatePackages: 2',
        '  minCrossPackageDuplicateBodySize: 150',
        '  entryPointHashes:',
        '    - abc',
        '    - def',
        '  severityOverrides:',
        '    graph:orphan-subtree: error',
      ].join('\n'),
    );
    const config = loadGraphConfig(workDir);
    expect(config.minDuplicateBodyLines).toBe(8);
    expect(config.minDuplicateBodySize).toBe(120);
    expect(config.minCrossPackageDuplicatePackages).toBe(2);
    expect(config.minCrossPackageDuplicateBodySize).toBe(150);
    expect(config.entryPointHashes).toEqual(['abc', 'def']);
    expect(config.severityOverrides).toEqual({ 'graph:orphan-subtree': 'error' });
  });

  it('returns {} when there is no graph: block', () => {
    writeConfig('cli:\n  verbose: true\n');
    expect(loadGraphConfig(workDir)).toEqual({});
  });

  it('returns {} when no config file is present', () => {
    expect(loadGraphConfig(workDir)).toEqual({});
  });

  // ADR-0023: strict-within-namespace. The graph schema rejects the whole
  // block on any malformed field (a wrong-typed knob, an unknown
  // severityOverrides value). The loader stays non-throwing — it falls back
  // to {} so a mid-run read uses the in-rule defaults; the strict rejection
  // surfaces as a CONFIGURATION_ERROR at the dispatch-level composed
  // validation (covered in the cli compose-validate tests), not here.
  it('returns {} when a field is malformed (schema rejects the block)', () => {
    writeConfig(
      [
        'graph:',
        '  minCrossPackageDuplicatePackages: "not-a-number"',
        '  entryPointHashes: 42',
        '  severityOverrides: []',
      ].join('\n'),
    );
    expect(loadGraphConfig(workDir)).toEqual({});
  });

  it('returns {} when a severityOverrides value is not error/warning (strict enum)', () => {
    writeConfig(['graph:', '  severityOverrides:', '    graph:bogus: nonsense'].join('\n'));
    expect(loadGraphConfig(workDir)).toEqual({});
  });

  it('returns {} when an unknown key is present in the graph: block (strict)', () => {
    writeConfig('graph:\n  minCrossPackageDuplicatePackges: 2\n');
    expect(loadGraphConfig(workDir)).toEqual({});
  });

  it('returns {} when the graph: value is not an object', () => {
    writeConfig('graph: 3\n');
    expect(loadGraphConfig(workDir)).toEqual({});
  });
});

// ADR-0023, Phase 4: when a RunScope is present, loadGraphConfig reads the
// host-RESOLVED `graph:` block off `scope.toolConfig.graph` and does NOT re-read
// YAML. These tests prove the value comes from the scope (and that an on-disk
// file is ignored when the scope is present — i.e. no second YAML read).
describe('loadGraphConfig reads scope.toolConfig.graph when a scope is present', () => {
  it('returns the resolved graph block off the scope, not the on-disk file', () => {
    // The on-disk file says minDuplicateBodyLines: 8 — a second YAML read would
    // surface this. The scope says 99; loadGraphConfig must return the SCOPE value.
    writeConfig('graph:\n  minDuplicateBodyLines: 8\n');
    const scope = makeGraphTestScope();
    Object.assign(scope, { toolConfig: { graph: { minDuplicateBodyLines: 99 } } });

    const config = runWithScopeSync(scope, () => loadGraphConfig(workDir));
    expect(config.minDuplicateBodyLines).toBe(99);
  });

  it('returns {} when the scope toolConfig has an empty graph block (no YAML fallback)', () => {
    // On-disk file has a populated graph block; an empty scope block must WIN —
    // proving the YAML read is skipped when the scope carries the resolved value.
    writeConfig('graph:\n  minDuplicateBodyLines: 8\n');
    const scope = makeGraphTestScope();
    Object.assign(scope, { toolConfig: { graph: {} } });

    const config = runWithScopeSync(scope, () => loadGraphConfig(workDir));
    expect(config).toEqual({});
  });

  it('falls back to the YAML read when the scope carries no toolConfig', () => {
    // A scope with no toolConfig (config-less project shape) → YAML fallback.
    writeConfig('graph:\n  minDuplicateBodyLines: 8\n');
    const scope = makeGraphTestScope();

    const config = runWithScopeSync(scope, () => loadGraphConfig(workDir));
    expect(config.minDuplicateBodyLines).toBe(8);
  });
});
