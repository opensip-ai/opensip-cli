/**
 * Whole-document validation across host + tool blocks (2.10.1, ADR-0023).
 *
 * The composed schema must validate the WHOLE `opensip-tools.config.yml`
 * document — the host-owned blocks (cli/dashboard/schemaVersion/targets/
 * globalExcludes/checkOverrides) AND the per-tool namespaces — through ONE
 * schema, with a typo in ANY block failing identically. This pins the seam
 * 2.10.1 flips: the document-level blocks are claimed namespaces now, not
 * `.catchall`-tolerated.
 */

import { ConfigurationError } from '@opensip-tools/core';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { composeConfigSchema, validateConfigDocument } from '../../composer.js';
import { hostConfigDeclarations } from '../host-declarations.js';

import type { ToolConfigDeclaration } from '../../declaration.js';

// Stand-in tool declarations (config cannot import the real tools — upward edge).
const fakeFitness: ToolConfigDeclaration = {
  namespace: 'fitness',
  schema: z.object({ failOnErrors: z.number().int().optional() }),
};
const fakeGraph: ToolConfigDeclaration = {
  namespace: 'graph',
  schema: z.object({ minDuplicateBodyLines: z.number().int().optional() }),
};

function schema() {
  return composeConfigSchema([...hostConfigDeclarations(), fakeFitness, fakeGraph]);
}

const WHOLE_DOCUMENT = {
  schemaVersion: 1,
  globalExcludes: ['dist/**'],
  targets: { backend: { description: 'Backend', include: ['src/**'] } },
  checkOverrides: { 'some-check': 'backend' },
  cli: { recipe: 'example', reportTo: 'https://cloud.test/api' },
  dashboard: { editor: 'vscode' },
  fitness: { failOnErrors: 1 },
  graph: { minDuplicateBodyLines: 10 },
};

describe('composed whole-document validation', () => {
  it('accepts a full, well-formed document across host + tool blocks', () => {
    expect(() => validateConfigDocument(schema(), WHOLE_DOCUMENT)).not.toThrow();
  });

  it.each([
    ['cli', { ...WHOLE_DOCUMENT, cli: { recipe: 'x', reprtTo: 'oops' } }],
    [
      'targets (non-kebab key)',
      { ...WHOLE_DOCUMENT, targets: { Backend: { description: 'x', include: ['a'] } } },
    ],
    [
      'targets (missing description)',
      { ...WHOLE_DOCUMENT, targets: { backend: { include: ['a'] } } },
    ],
    ['fitness', { ...WHOLE_DOCUMENT, fitness: { faliOnErrors: 1 } }],
    ['graph', { ...WHOLE_DOCUMENT, graph: { minDuplicateBodyLine: 10 } }],
  ])('throws one ConfigurationError on a typo in the %s block', (_label, doc) => {
    expect(() => validateConfigDocument(schema(), doc)).toThrow(ConfigurationError);
  });

  it('still tolerates a genuinely-unknown top-level key (forward-compat catchall)', () => {
    expect(() =>
      validateConfigDocument(schema(), { ...WHOLE_DOCUMENT, someFutureBlock: { x: 1 } }),
    ).not.toThrow();
  });
});
