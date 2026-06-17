/**
 * Whole-document validation across host + tool blocks (2.10.1, ADR-0023).
 *
 * The composed schema must validate the WHOLE `opensip-cli.config.yml`
 * document — the host-owned blocks (cli/dashboard/schemaVersion/targets/
 * globalExcludes/checkOverrides) AND the per-tool namespaces — through ONE
 * schema, with a typo in ANY block failing identically. This pins the seam
 * 2.10.1 flips: the document-level blocks are claimed namespaces now, not
 * `.catchall`-tolerated.
 */

import { ConfigurationError } from '@opensip-cli/core';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { composeConfigSchema, validateConfigDocument } from '../../composer.js';
import { decorateToolConfigDeclarationsWithGateKeys } from '../../gate-keys.js';
import { hostConfigDeclarations } from '../host-declarations.js';

import type { ToolConfigDeclaration } from '../../declaration.js';
import type { PluginConfigKeyDeclaration } from '../targeting.js';

// Stand-in tool declarations (config cannot import the real tools — upward edge).
const fakeFitness: ToolConfigDeclaration = {
  namespace: 'fitness',
  schema: z.object({ failOnErrors: z.number().int().optional(), recipe: z.string().optional() }),
};
const fakeGraph: ToolConfigDeclaration = {
  namespace: 'graph',
  schema: z.object({ minDuplicateBodyLines: z.number().int().optional() }),
};

const PLUGIN_CONFIG_KEYS: readonly PluginConfigKeyDeclaration[] = [
  { key: 'checkPackages', kind: 'packages' },
  { key: 'scenarioPackages', kind: 'packages' },
  { key: 'autoDiscoverScenarios', kind: 'autoDiscover' },
  { key: 'packageScopes', kind: 'scopes' },
  { key: 'graphAdapters', kind: 'packages' },
  { key: 'autoDiscoverGraphAdapters', kind: 'autoDiscover' },
];

function schema() {
  return composeConfigSchema([
    ...hostConfigDeclarations({ pluginConfigKeys: PLUGIN_CONFIG_KEYS }),
    ...decorateToolConfigDeclarationsWithGateKeys([fakeFitness, fakeGraph]),
  ]);
}

const WHOLE_DOCUMENT = {
  schemaVersion: 1,
  globalExcludes: ['dist/**'],
  targets: { backend: { description: 'Backend', include: ['src/**'] } },
  checkOverrides: { 'some-check': 'backend' },
  cli: { reportTo: 'https://cloud.test/api' },
  dashboard: { editor: 'vscode' },
  plugins: {
    fit: ['@acme/fit-pack'],
    checkPackages: ['@acme/checks'],
    scenarioPackages: ['@acme/scenarios-load'],
    autoDiscoverScenarios: false,
    packageScopes: ['@acme'],
    graphAdapters: ['@acme/graph-cpp'],
    autoDiscoverGraphAdapters: false,
  },
  fitness: { failOnErrors: 1, recipe: 'example' },
  graph: { minDuplicateBodyLines: 10 },
};

describe('composed whole-document validation', () => {
  it('accepts a full, well-formed document across host + tool blocks', () => {
    expect(() => validateConfigDocument(schema(), WHOLE_DOCUMENT)).not.toThrow();
  });

  it.each([
    ['cli', { ...WHOLE_DOCUMENT, cli: { reportTo: 'https://cloud.test/api', reprtTo: 'oops' } }],
    [
      'targets (non-kebab key)',
      { ...WHOLE_DOCUMENT, targets: { Backend: { description: 'x', include: ['a'] } } },
    ],
    [
      'targets (missing description)',
      { ...WHOLE_DOCUMENT, targets: { backend: { include: ['a'] } } },
    ],
    ['plugins (unknown key)', { ...WHOLE_DOCUMENT, plugins: { scenarioPackagez: ['oops'] } }],
    [
      'plugins (wrong auto-discovery type)',
      { ...WHOLE_DOCUMENT, plugins: { autoDiscoverGraphAdapters: 'false' } },
    ],
    ['fitness', { ...WHOLE_DOCUMENT, fitness: { faliOnErrors: 1 } }],
    ['graph', { ...WHOLE_DOCUMENT, graph: { minDuplicateBodyLine: 10 } }],
  ])('throws one ConfigurationError on a typo in the %s block', (_label, doc) => {
    expect(() => validateConfigDocument(schema(), doc)).toThrow(ConfigurationError);
  });

  it('rejects the removed cli.recipe fallback', () => {
    expect(() =>
      validateConfigDocument(schema(), {
        ...WHOLE_DOCUMENT,
        cli: { reportTo: 'https://cloud.test/api', recipe: 'example' },
      }),
    ).toThrow(ConfigurationError);
  });

  it('accepts reserved gate keys in decorated tool namespaces', () => {
    expect(() =>
      validateConfigDocument(schema(), {
        ...WHOLE_DOCUMENT,
        fitness: {
          failOnErrors: 1,
          failOnWarnings: 0,
          failOnDegraded: false,
          recipe: 'example',
        },
        graph: {
          minDuplicateBodyLines: 10,
          failOnErrors: 0,
          failOnWarnings: 2,
          failOnDegraded: false,
        },
      }),
    ).not.toThrow();
  });

  it('does not add reserved gate keys to host namespaces', () => {
    expect(() =>
      validateConfigDocument(schema(), {
        ...WHOLE_DOCUMENT,
        cli: { reportTo: 'https://cloud.test/api', failOnDegraded: false },
      }),
    ).toThrow(ConfigurationError);
  });

  it('rejects numeric failOnDegraded because the reserved key is boolean-only', () => {
    expect(() =>
      validateConfigDocument(schema(), {
        ...WHOLE_DOCUMENT,
        graph: { minDuplicateBodyLines: 10, failOnDegraded: 0 },
      }),
    ).toThrow(ConfigurationError);
  });

  it('still tolerates a genuinely-unknown top-level key (forward-compat catchall)', () => {
    expect(() =>
      validateConfigDocument(schema(), { ...WHOLE_DOCUMENT, someFutureBlock: { x: 1 } }),
    ).not.toThrow();
  });
});
