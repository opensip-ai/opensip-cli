/**
 * @fileoverview Dashboard graph-tab render wiring (Plan B, Phase 5 Task 5.4).
 *
 * Feeds a DashboardInput carrying graphRuleCatalog + graphRecipeCatalog through
 * generateDashboardHtml and asserts the emitted HTML embeds the graph rule
 * slugs + recipe names. Also re-confirms decoupling: @opensip-tools/dashboard
 * has no @opensip-tools/graph dependency.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('dashboard graph-tab — rule/recipe catalog wiring', () => {
  const html = generateDashboardHtml({
    sessions: [],
    graphRuleCatalog: [
      { slug: 'graph:orphan-subtree', defaultSeverity: 'warning', source: 'built-in' },
      { slug: 'graph:duplicated-function-body', defaultSeverity: 'warning', source: 'built-in' },
    ],
    graphRecipeCatalog: [
      { name: 'default', displayName: 'Default', description: 'Run all graph rules', tags: ['default'], selectorType: 'all' },
    ],
  });

  it('emits the graphRuleCatalog JS const carrying the rule slugs', () => {
    expect(html).toContain('const graphRuleCatalog =');
    expect(html).toContain('graph:orphan-subtree');
    expect(html).toContain('graph:duplicated-function-body');
  });

  it('emits the graphRecipeCatalog JS const carrying the recipe display name', () => {
    expect(html).toContain('const graphRecipeCatalog =');
    expect(html).toContain('Default');
  });

  it('keeps the graphRuleCatalog/graphRecipeCatalog consts distinct from the fitness check/recipe consts', () => {
    // The fitness-owned consts are still emitted; the graph consts must not
    // clobber them (distinct keys).
    expect(html).toContain('const checkCatalog =');
    expect(html).toContain('const recipeCatalog =');
    expect(html).toContain('const graphRuleCatalog =');
    expect(html).toContain('const graphRecipeCatalog =');
  });

  it('@opensip-tools/dashboard declares no @opensip-tools/graph dependency (decoupled)', () => {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.['@opensip-tools/graph']).toBeUndefined();
    expect(pkg.devDependencies?.['@opensip-tools/graph']).toBeUndefined();
  });
});
