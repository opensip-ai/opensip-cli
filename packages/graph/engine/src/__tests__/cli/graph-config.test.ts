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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadGraphConfig } from '../../cli/graph-config.js';

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
    writeConfig('cli:\n  recipe: example\n');
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
    writeConfig(
      [
        'graph:',
        '  severityOverrides:',
        '    graph:bogus: nonsense',
      ].join('\n'),
    );
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
