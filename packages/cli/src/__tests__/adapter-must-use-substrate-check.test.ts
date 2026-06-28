/**
 * Unit coverage for the project-local `adapter-must-use-substrate` dogfood check
 * (ADR-0090). Project-local .mjs checks have no per-pack fixture-coverage harness,
 * so — like the sibling tool-engine path guards — the cli package owns the
 * pass/fire assertions: the three REAL adapters pass, the committed violation
 * fixture fires, and the path gate excludes the substrate + tests/fixtures.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyzeAdapterMustUseSubstrate } from '../../../../opensip-cli/fit/checks/adapter-must-use-substrate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// .../packages/cli/src/__tests__ → repo root is four levels up.
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

const FIXTURE_BASE = 'opensip-cli/fit/checks/__fixtures__/adapter-must-use-substrate';
// The path passed to the analyzer is a SYNTHETIC adapter source path: the real
// fixture path contains `__fixtures__`, which the check's NON_SOURCE gate excludes.
const ADAPTER_PATH = 'packages/tool-gitleaks/src/tool.ts';

describe('adapter-must-use-substrate — passes against the real adapters', () => {
  for (const pkg of ['tool-gitleaks', 'tool-osv-scanner', 'tool-trivy']) {
    it(`the real ${pkg} descriptor uses the substrate (no findings)`, () => {
      const path = `packages/${pkg}/src/tool.ts`;
      expect(analyzeAdapterMustUseSubstrate(read(path), path)).toEqual([]);
    });
  }

  it('the clean fixture (defineExternalToolAdapter, execFile only in a comment) passes', () => {
    const content = read(`${FIXTURE_BASE}/clean/packages/tool-gitleaks/src/tool.ts`);
    expect(analyzeAdapterMustUseSubstrate(content, ADAPTER_PATH)).toEqual([]);
  });
});

describe('adapter-must-use-substrate — fires on a hand-rolled adapter', () => {
  it('the violation fixture (child_process + execFile + defineTool) fires once, error-rung', () => {
    const content = read(`${FIXTURE_BASE}/violation/packages/tool-gitleaks/src/tool.ts`);
    const findings = analyzeAdapterMustUseSubstrate(content, ADAPTER_PATH);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.type).toBe('adapter-must-use-substrate');
    expect(findings[0]?.severity).toBe('error');
    // Both independent signals are named in the message.
    expect(findings[0]?.message).toContain('child_process');
    expect(findings[0]?.message).toContain('defineTool');
  });

  it('fires on a direct node:child_process import alone', () => {
    const content = "import { execFile } from 'node:child_process';\nexport const x = 1;\n";
    expect(analyzeAdapterMustUseSubstrate(content, ADAPTER_PATH)).toHaveLength(1);
  });

  it('fires on a bare child_process import (no node: prefix)', () => {
    const content = "import { spawn } from 'child_process';\n";
    expect(analyzeAdapterMustUseSubstrate(content, ADAPTER_PATH)).toHaveLength(1);
  });

  it('fires on an execFile call even without importing child_process by name', () => {
    const content = "import * as cp from 'node:child_process';\ncp.execFile('x', []);\n";
    expect(analyzeAdapterMustUseSubstrate(content, ADAPTER_PATH)).toHaveLength(1);
  });

  it('fires on a raw defineTool call', () => {
    const content =
      "import { defineTool } from '@opensip-cli/core';\nexport const t = defineTool({});\n";
    const findings = analyzeAdapterMustUseSubstrate(content, ADAPTER_PATH);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('defineTool');
  });
});

describe('adapter-must-use-substrate — path gate', () => {
  const childProcess = "import { execFile } from 'node:child_process';\nexecFile('x', []);\n";

  it('does NOT flag the substrate (it legitimately owns subprocess execution)', () => {
    const real = read('packages/external-tool-adapter/src/process-exec.ts');
    expect(
      analyzeAdapterMustUseSubstrate(real, 'packages/external-tool-adapter/src/process-exec.ts'),
    ).toEqual([]);
  });

  it('does NOT flag tool-test-kit (layer-2 published helper, not an adapter)', () => {
    expect(
      analyzeAdapterMustUseSubstrate(childProcess, 'packages/tool-test-kit/src/index.ts'),
    ).toEqual([]);
  });

  it('does NOT flag adapter test files', () => {
    expect(
      analyzeAdapterMustUseSubstrate(
        childProcess,
        'packages/tool-gitleaks/src/__tests__/worker-e2e.test.ts',
      ),
    ).toEqual([]);
  });

  it('does NOT flag a non-adapter package', () => {
    expect(
      analyzeAdapterMustUseSubstrate(childProcess, 'packages/graph/engine/src/run.ts'),
    ).toEqual([]);
  });
});
