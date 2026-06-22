/**
 * @fileoverview Behaviour tests for the ADR-0054 M4-G CAPSTONE host-process tool
 * runtime import boundary check. After the capstone: external runtimes never
 * import in the host; `importToolRuntime` stays in the admission/discovery
 * boundary; host imports are bundled-only; the external worker policy is confined
 * to the worker-owned plane.
 */
import { runCheckOnFixture, type FixtureFile } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { analyzeHostToolRuntimeImportBoundary } from '../checks/architecture/host-tool-runtime-import-boundary.js';
import { checks } from '../index.js';

const DISCOVERY_PATH = 'packages/cli/src/bootstrap/register-tools-discovery.ts';
const REGISTER_TOOLS_PATH = 'packages/cli/src/bootstrap/register-tools.ts';
const ADMISSION_PATH = 'packages/cli/src/bootstrap/admit-tool-package.ts';
const WORKER_ENTRY_PATH = 'packages/cli/src/bootstrap/tool-command-worker-entry.ts';
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

describe('analyzeHostToolRuntimeImportBoundary (AST, M4-G capstone)', () => {
  it('allows a BUNDLED host import in the discovery boundary', () => {
    const v = analyzeHostToolRuntimeImportBoundary(
      [
        "import { hostRuntimeImportPolicyFor, importToolRuntime } from './admit-tool-package.js';",
        'export async function load(dir: string) {',
        "  return importToolRuntime(dir, hostRuntimeImportPolicyFor('bundled'));",
        '}',
      ].join('\n'),
      DISCOVERY_PATH,
    );
    expect(v).toEqual([]);
  });

  it("allows a literal { source: 'bundled' } host import", () => {
    const v = analyzeHostToolRuntimeImportBoundary(
      [
        "import { importToolRuntime } from './admit-tool-package.js';",
        'export async function load(dir: string) {',
        "  return importToolRuntime(dir, { source: 'bundled' });",
        '}',
      ].join('\n'),
      REGISTER_TOOLS_PATH,
    );
    expect(v).toEqual([]);
  });

  it('allows the WORKER policy on the worker-owned plane (discovery file)', () => {
    const v = analyzeHostToolRuntimeImportBoundary(
      [
        "import { importToolRuntime, workerRuntimeImportPolicyFor } from './admit-tool-package.js';",
        'export async function load(dir: string, source: ToolSource) {',
        '  return importToolRuntime(dir, workerRuntimeImportPolicyFor(source));',
        '}',
      ].join('\n'),
      DISCOVERY_PATH,
    );
    expect(v).toEqual([]);
  });

  it('FLAGS the WORKER policy in an allowlisted-callsite that is NOT on the worker plane (register-tools)', () => {
    // register-tools.ts may call importToolRuntime (it bootstraps BUNDLED tools)
    // but must pass a bundled policy — the worker policy would import an external
    // runtime in the host.
    const v = analyzeHostToolRuntimeImportBoundary(
      [
        "import { importToolRuntime, workerRuntimeImportPolicyFor } from './admit-tool-package.js';",
        'export async function load(dir: string, source: ToolSource) {',
        '  return importToolRuntime(dir, workerRuntimeImportPolicyFor(source));',
        '}',
      ].join('\n'),
      REGISTER_TOOLS_PATH,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('worker-owned dispatch plane');
  });

  it('flags missing/unknown policy even in the admitted boundary files', () => {
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
    expect(v[0]?.message).toContain('explicit policy');
  });

  it('flags any new callsite outside admission/discovery', () => {
    const v = analyzeHostToolRuntimeImportBoundary(
      [
        "import { hostRuntimeImportPolicyFor, importToolRuntime } from '../bootstrap/admit-tool-package.js';",
        'export async function load(dir: string) {',
        "  return importToolRuntime(dir, hostRuntimeImportPolicyFor('bundled'));",
        '}',
      ].join('\n'),
      OTHER_CLI_PATH,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('admission/discovery boundary');
  });

  it('allows the WORKER policy in the worker entry (the forked isolation boundary)', () => {
    const v = analyzeHostToolRuntimeImportBoundary(
      [
        "import { importToolRuntime, workerRuntimeImportPolicyFor } from './admit-tool-package.js';",
        'export async function run(dir: string, source: ToolSource) {',
        '  return importToolRuntime(dir, workerRuntimeImportPolicyFor(source));',
        '}',
      ].join('\n'),
      WORKER_ENTRY_PATH,
    );
    expect(v).toEqual([]);
  });

  it('flags a missing policy in the worker entry too', () => {
    const v = analyzeHostToolRuntimeImportBoundary(
      [
        "import { importToolRuntime } from './admit-tool-package.js';",
        'export async function run(dir: string) {',
        '  return importToolRuntime(dir);',
        '}',
      ].join('\n'),
      WORKER_ENTRY_PATH,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('explicit policy');
  });

  it('allows the defining module to call its local function with a worker policy', () => {
    // admit-tool-package.ts defines workerRuntimeImportPolicyFor and runs the
    // bundled/probe runtime-load section — it is on the worker-policy allowlist.
    const v = analyzeHostToolRuntimeImportBoundary(
      [
        'export async function admit(dir: string, source: ToolSource) {',
        '  return importToolRuntime(dir, workerRuntimeImportPolicyFor(source));',
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
          "  return importToolRuntime(dir, hostRuntimeImportPolicyFor('bundled'));",
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
