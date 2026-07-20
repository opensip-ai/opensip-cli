import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RunScope,
  admitTool,
  applyToolContributeScope,
  createCapabilityRegistry,
  loadCapabilityDomain,
  loadToolManifest,
  registerCapabilityDomainsFromManifest,
  resolveToolHooks,
  runWithScope,
} from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { currentCheckRegistry } from '../framework/scope-registry.js';
import { resolveChecks } from '../recipes/check-resolution.js';
import { fitnessTool } from '../tool.js';

const ENGINE_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ADMIT_ALL = () => ({ admit: true }) as const;
const SHARED_SLUG = 'shared-check';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'opensip-fit-namespace-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function writeFitPack(packageName: string, checkId: string): void {
  const packageDir = join(projectDir, 'node_modules', packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      type: 'module',
      main: './index.mjs',
      opensipTools: {
        kind: 'fit-pack',
        targetDomain: 'fit-pack',
        targetDomainApiVersion: 1,
      },
    }),
  );
  writeFileSync(
    join(packageDir, 'index.mjs'),
    `
      export const checks = [{
        config: {
          id: '${checkId}',
          slug: '${SHARED_SLUG}',
          tags: ['test'],
          description: 'namespace provenance fixture',
          analysisMode: 'analyze',
          scope: { type: 'all' },
          itemType: 'file',
          execute: async () => ({ status: 'passed', violations: [] }),
        },
        run: async () => ({ status: 'passed', violations: [] }),
        getScope: () => ({ type: 'all' }),
        getMatcher: () => ({ matches: () => true }),
      }];
    `,
  );
}

function makeFitnessScope(): {
  readonly scope: RunScope;
  readonly capabilities: ReturnType<typeof createCapabilityRegistry>;
} {
  const scope = new RunScope();
  applyToolContributeScope(scope, fitnessTool);

  const capabilities = createCapabilityRegistry();
  const manifest = loadToolManifest('bundled', ENGINE_DIR);
  if (manifest === undefined) throw new Error('fitness manifest was not loadable');
  const admission = admitTool({
    manifest,
    source: 'bundled',
    dir: ENGINE_DIR,
    explicitlyRequested: true,
  });
  if (admission.decision !== 'admit') throw new Error('fitness manifest was not admitted');
  registerCapabilityDomainsFromManifest(admission.manifest, capabilities);

  for (const [domainId, registrar] of Object.entries(
    resolveToolHooks(fitnessTool).capabilityRegistrars ?? {},
  )) {
    if (capabilities.hasDomain(domainId)) capabilities.setRegistrar(domainId, registrar);
  }
  scope.capabilities = capabilities;
  return { scope, capabilities };
}

describe('fit-pack capability namespace provenance', () => {
  it('keeps colliding slugs under their source-package namespaces and fails closed on bare lookup', async () => {
    writeFitPack('@acme/checks-a', '00000000-0000-4000-8000-000000000001');
    writeFitPack('@other/checks-b', '00000000-0000-4000-8000-000000000002');
    const { scope, capabilities } = makeFitnessScope();

    try {
      await runWithScope(scope, async () => {
        const errors = await loadCapabilityDomain({
          registry: capabilities,
          domainId: 'fit-pack',
          projectDir,
          shouldLoadPackage: ADMIT_ALL,
        });
        const registry = currentCheckRegistry();
        const namespacedSlugs = [`@acme/checks-a:${SHARED_SLUG}`, `@other/checks-b:${SHARED_SLUG}`];

        expect(errors).toEqual([]);
        expect(registry.listSlugs().sort()).toEqual(namespacedSlugs);
        expect(resolveChecks({ type: 'explicit', checkIds: namespacedSlugs }, registry)).toEqual(
          namespacedSlugs,
        );
        expect(resolveChecks({ type: 'explicit', checkIds: [SHARED_SLUG] }, registry)).toEqual([]);
      });
    } finally {
      scope.dispose();
    }
  });
});
