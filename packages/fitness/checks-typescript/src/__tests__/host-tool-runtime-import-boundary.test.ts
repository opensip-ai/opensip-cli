/**
 * @fileoverview Behaviour tests for the ADR-0054 host-process tool runtime
 * import boundary check.
 */
import { runCheckOnFixture, type FixtureFile } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { analyzeHostToolRuntimeImportBoundary } from '../checks/architecture/host-tool-runtime-import-boundary.js';
import { checks } from '../index.js';

const DISCOVERY_PATH = 'packages/cli/src/bootstrap/register-tools.ts';
const ADMISSION_PATH = 'packages/cli/src/bootstrap/admit-tool-package.ts';
const OTHER_CLI_PATH = 'packages/cli/src/commands/plugin.ts';

function check() {
  const c = checks.find((x) => x.config.slug === 'host-tool-runtime-import-boundary');
  if (!c) throw new Error('check not found: host-tool-runtime-import-boundary');
  return c;
}

async function findingsFor(file: FixtureFile): Promise<number> {
  const run = await runCheckOnFixture(check(), { files: [file] });
  return run.findings.length;
}

describe('analyzeHostToolRuntimeImportBoundary (AST)', () => {
  it('allows the discovery boundary when a policy helper is present', () => {
    const v = analyzeHostToolRuntimeImportBoundary(
      [
        "import { hostRuntimeImportPolicyFor, importToolRuntime } from './admit-tool-package.js';",
        'export async function load(dir: string) {',
        "  return importToolRuntime(dir, hostRuntimeImportPolicyFor('installed'));",
        '}',
      ].join('\n'),
      DISCOVERY_PATH,
    );
    expect(v).toEqual([]);
  });

  it('flags missing policy even in the admitted boundary files', () => {
    const v = analyzeHostToolRuntimeImportBoundary(
      [
        "import { importToolRuntime } from './admit-tool-package.js';",
        'export async function load(dir: string) {',
        '  return importToolRuntime(dir);',
        '}',
      ].join('\n'),
      DISCOVERY_PATH,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('explicit source policy');
  });

  it('flags any new callsite outside admission/discovery', () => {
    const v = analyzeHostToolRuntimeImportBoundary(
      [
        "import { hostRuntimeImportPolicyFor, importToolRuntime } from '../bootstrap/admit-tool-package.js';",
        'export async function load(dir: string) {',
        "  return importToolRuntime(dir, hostRuntimeImportPolicyFor('installed'));",
        '}',
      ].join('\n'),
      OTHER_CLI_PATH,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('admission/discovery boundary');
  });

  it('allows the defining module to call its local function with policy', () => {
    const v = analyzeHostToolRuntimeImportBoundary(
      [
        'export async function admit(dir: string, source: ToolSource) {',
        '  return importToolRuntime(dir, hostRuntimeImportPolicyFor(source));',
        '}',
      ].join('\n'),
      ADMISSION_PATH,
    );
    expect(v).toEqual([]);
  });
});

describe('host-tool-runtime-import-boundary (gate)', () => {
  it('flags an out-of-boundary CLI runtime import', async () => {
    expect(
      await findingsFor({
        path: OTHER_CLI_PATH,
        content: [
          "import { hostRuntimeImportPolicyFor, importToolRuntime } from '../bootstrap/admit-tool-package.js';",
          'export async function load(dir: string) {',
          "  return importToolRuntime(dir, hostRuntimeImportPolicyFor('installed'));",
          '}',
        ].join('\n'),
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag non-CLI paths', async () => {
    expect(
      await findingsFor({
        path: 'packages/fitness/engine/src/tool.ts',
        content: [
          "import { importToolRuntime } from 'opensip-cli/bootstrap/admit-tool-package.js';",
          'export const x = importToolRuntime;',
        ].join('\n'),
      }),
    ).toBe(0);
  });
});
