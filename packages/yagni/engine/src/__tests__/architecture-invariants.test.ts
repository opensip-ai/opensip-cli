/**
 * Architectural invariant probes (ADR-0064): yagni must never import graph;
 * @opensip-cli/clone-detection must stay a leaf.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

describe('ADR-0064 architectural invariants', () => {
  it('yagni package.json declares no @opensip-cli/graph dependency', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@opensip-cli/graph');
  });

  it('clone-detection package.json declares no workspace dependencies', () => {
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../clone-detection/package.json', import.meta.url)),
        'utf8',
      ),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(all.filter((n) => n.startsWith('@opensip-cli/'))).toEqual([]);
    expect(all).not.toContain('opensipTools');
  });

  it('dependency-cruiser wires clone-detection-imports-nothing and yagni-no-graph rules', () => {
    const config = readFileSync(`${REPO_ROOT}/.config/dependency-cruiser.cjs`, 'utf8');
    expect(config).toContain('clone-detection-imports-nothing');
    expect(config).toContain('yagni-no-graph-engine');
    expect(config).toContain('yagni-no-graph-adapter-packs');
  });

  it('YagniDetector contract has no requiresGraph field (S5)', () => {
    const types = readFileSync(
      fileURLToPath(new URL('../detectors/types.ts', import.meta.url)),
      'utf8',
    );
    expect(types).not.toContain('requiresGraph');
    expect(types).not.toContain('graph-unavailable');
  });

  it('planDetectors has no graph-gated branch', () => {
    const execute = readFileSync(
      fileURLToPath(new URL('../cli/execute-yagni.ts', import.meta.url)),
      'utf8',
    );
    expect(execute).not.toContain('requiresGraph');
    expect(execute).not.toContain('graph-unavailable');
  });
});
