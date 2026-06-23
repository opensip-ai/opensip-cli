/**
 * @fileoverview ADR-0054 M4-G CAPSTONE invariant proof: no `importToolRuntime`
 * for external-provenance tools in the HOST process.
 *
 * The host registers a manifest-derived synthetic Tool for an external tool and
 * mounts its command shells from the static manifest — it NEVER imports the
 * untrusted runtime. The forked dispatch WORKER
 * (`OPENSIP_CLI_IN_TOOL_WORKER=1`) imports the real runtime at dispatch time
 * (the isolation boundary). These tests prove BOTH halves of that branch:
 *
 *   - HOST (no IN_TOOL_WORKER): discovery synthesizes. The fixture writes a
 *     module-global sentinel file ONLY when its runtime module is EVALUATED
 *     (imported). We assert the sentinel is ABSENT after host discovery (proof
 *     the runtime was never imported), the tool IS registered with command
 *     shells from the manifest, the synthetic handler throws the fail-loud stub,
 *     and the tool carries NO real extensionPoints.
 *   - WORKER (IN_TOOL_WORKER=1): discovery imports. The sentinel IS written
 *     (proof the runtime ran) and the registered tool carries the REAL
 *     extensionPoints + a non-stub handler.
 *
 * It also proves the type-level capstone: `hostRuntimeImportPolicyFor` accepts
 * ONLY `'bundled'` — a non-bundled argument is a COMPILE error
 * (`@ts-expect-error`), not a runtime guard.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SystemError,
  ToolRegistry as ToolRegistryClass,
  type ToolProvenance,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hostRuntimeImportPolicyFor,
  type ToolRuntimeImportPolicy,
} from '../bootstrap/admit-tool-package.js';
import { discoverAndRegisterToolPackages } from '../bootstrap/register-tools.js';
import { INSTALLED_TOOL_ALLOWLIST_ENV } from '../bootstrap/tool-trust.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PKG_ROOT = join(HERE, '..', '..');
const FIXTURE_SCOPE = join(CLI_PKG_ROOT, 'node_modules', '@opensip-cli-fixture');
const FIXTURE_DIR = join(FIXTURE_SCOPE, 'm4g-sentinel');
const SENTINEL_FILE = join(FIXTURE_DIR, 'imported.sentinel');
const FIXTURE_ID = 'm4g-sentinel-tool';
const STABLE_ID = '00000000-0000-4000-8000-0000000m4g01';

const WALK_UP_SOURCE_LIST = [{ dir: CLI_PKG_ROOT, mode: 'walkUp' as const }];

/**
 * Stage a fixture whose runtime module writes a sentinel FILE at evaluation time
 * (top-level side effect). The presence of the file is a definitive cross-call
 * proof that `import()` ran on the module — robust to the per-run module cache
 * (a re-import of the same URL would be cached, but the FILE persists from the
 * first evaluation, so the worker case still observes it).
 */
function stageSentinelFixture(): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(
    join(FIXTURE_DIR, 'package.json'),
    JSON.stringify({
      name: '@opensip-cli-fixture/m4g-sentinel',
      version: '0.0.0',
      type: 'module',
      main: './index.js',
      opensipTools: {
        kind: 'tool',
        id: FIXTURE_ID,
        identity: { name: FIXTURE_ID },
        stableId: STABLE_ID,
        apiVersion: 1,
        commands: [
          {
            name: FIXTURE_ID,
            description: 'sentinel external command',
            commonFlags: [],
            scope: 'project',
            output: 'command-result',
          },
        ],
      },
    }),
    'utf8',
  );
  writeFileSync(
    join(FIXTURE_DIR, 'index.js'),
    [
      // Top-level side effect: writing this file proves the module was EVALUATED
      // (imported). The host must NEVER trigger it; the worker must.
      "import { writeFileSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      "import { dirname, join } from 'node:path';",
      'const here = dirname(fileURLToPath(import.meta.url));',
      "writeFileSync(join(here, 'imported.sentinel'), 'imported', 'utf8');",
      'export const tool = {',
      `  identity: { name: '${FIXTURE_ID}' },`,
      `  metadata: { id: '${STABLE_ID}', name: '${FIXTURE_ID}', version: '0.0.0', description: 'fixture' },`,
      '  extensionPoints: { initialize: () => undefined },',
      `  commands: [{ name: '${FIXTURE_ID}', description: 'sentinel external command' }],`,
      '  commandSpecs: [{',
      `    name: '${FIXTURE_ID}', description: 'sentinel external command', commonFlags: [],`,
      "    scope: 'project', output: 'command-result',",
      "    handler: () => Promise.resolve({ type: 'text-lines', title: 'real', lines: [] }),",
      '  }],',
      '};',
    ].join('\n'),
    'utf8',
  );
}

function clearSentinel(): void {
  rmSync(SENTINEL_FILE, { force: true });
}

beforeEach(() => {
  stageSentinelFixture();
  clearSentinel();
});

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('ADR-0054 M4-G capstone — host never imports external runtime', () => {
  it('HOST discovery synthesizes from the manifest (no runtime import; sentinel absent)', async () => {
    const registry = new ToolRegistryClass();
    const provenance: ToolProvenance[] = [];
    await discoverAndRegisterToolPackages(
      registry,
      // HOST env: allowlist the fixture, but NO OPENSIP_CLI_IN_TOOL_WORKER.
      { sources: WALK_UP_SOURCE_LIST, env: { [INSTALLED_TOOL_ALLOWLIST_ENV]: FIXTURE_ID } },
      new Set<string>(),
      provenance,
    );

    // The runtime module was NEVER imported → no sentinel written.
    expect(existsSync(SENTINEL_FILE)).toBe(false);

    // The tool IS registered — its command shell mounted from the manifest.
    const tool = registry.get(FIXTURE_ID);
    expect(tool).toBeDefined();
    expect(tool?.metadata.id).toBe(STABLE_ID);
    expect(tool?.commandSpecs.map((s) => s.name)).toEqual([FIXTURE_ID]);
    // Synthetic: NO real runtime hooks (the host runs none for external tools).
    expect(tool?.extensionPoints).toBeUndefined();
    // The handler is the fail-loud dispatch stub (the host never calls it; the
    // worker owns the real handler). Calling it directly proves the stub.
    expect(() => tool?.commandSpecs[0]?.handler({}, {} as never)).toThrow(SystemError);
    // Provenance was still recorded for `plugin list`.
    expect(provenance.some((p) => p.id === FIXTURE_ID)).toBe(true);
  });

  it('WORKER discovery imports the real runtime (sentinel written; real hooks)', async () => {
    const registry = new ToolRegistryClass();
    await discoverAndRegisterToolPackages(
      registry,
      // WORKER env: the isolation boundary — the real runtime legitimately loads.
      {
        sources: WALK_UP_SOURCE_LIST,
        env: { [INSTALLED_TOOL_ALLOWLIST_ENV]: FIXTURE_ID, OPENSIP_CLI_IN_TOOL_WORKER: '1' },
      },
      new Set<string>(),
    );

    // The runtime module WAS imported → sentinel written.
    expect(existsSync(SENTINEL_FILE)).toBe(true);

    const tool = registry.get(FIXTURE_ID);
    expect(tool).toBeDefined();
    // The worker holds the REAL runtime: real extensionPoints, not a synthetic stub.
    expect(tool?.extensionPoints?.initialize).toBeTypeOf('function');
  });

  it('hostRuntimeImportPolicyFor is bundled-only (type-enforced capstone)', () => {
    const policy: ToolRuntimeImportPolicy = hostRuntimeImportPolicyFor('bundled');
    expect(policy).toEqual({ source: 'bundled' });

    // The capstone invariant is a COMPILE error, not a runtime guard: a
    // non-bundled source cannot produce a HOST import policy. The @ts-expect-error
    // FAILS the typecheck if this ever becomes assignable again.
    // @ts-expect-error — hostRuntimeImportPolicyFor accepts ONLY 'bundled' (ADR-0054 M4-G).
    expect(() => hostRuntimeImportPolicyFor('installed')).toBeTypeOf('function');
  });
});
