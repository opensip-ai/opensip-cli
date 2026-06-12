/**
 * @fileoverview Behaviour tests for the AST-based phantom-dependency-detection
 * check. The headline invariant — and the reason this check was rewritten off a
 * regex/text extractor onto the TypeScript AST — is that import-like text inside
 * a string literal must NEVER be mistaken for a real import.
 *
 * Uses the engine's `runCheckOnFixture` harness (writes a tiny project to a temp
 * dir, runs the one check, returns only its `fit:<slug>` findings) so the file
 * resolution path matches production exactly.
 */

import { runCheckOnFixture, type FixtureFile } from '@opensip-tools/test-support';
import { describe, expect, it } from 'vitest';

import { checks } from '../index.js';

function check() {
  const c = checks.find((x) => x.config.slug === 'phantom-dependency-detection');
  if (!c) throw new Error('check not found: phantom-dependency-detection');
  return c;
}

const PKG: FixtureFile = {
  path: 'package.json',
  content: JSON.stringify({
    name: 'demo',
    dependencies: { 'declared-pkg': '^1.0.0' },
    devDependencies: { 'dev-only-pkg': '^1.0.0' },
  }),
};

async function phantomMatches(...files: FixtureFile[]): Promise<string[]> {
  const run = await runCheckOnFixture(check(), { files: [PKG, ...files] });
  return run.findings.map((s) => {
    const match = s.metadata?.match;
    return typeof match === 'string' ? match : '';
  });
}

describe('phantom-dependency-detection (AST)', () => {
  it('flags an external import not declared in package.json', async () => {
    const matches = await phantomMatches({
      path: 'a.ts',
      content: `import { x } from 'undeclared-pkg'\nexport const y = x`,
    });
    expect(matches).toContain('undeclared-pkg');
  });

  it('does not flag declared deps, node built-ins, or relative imports', async () => {
    const matches = await phantomMatches({
      path: 'a.ts',
      content: [
        `import { thing } from 'declared-pkg'`,
        `import { readFileSync } from 'node:fs'`,
        `import { readFile } from 'fs/promises'`,
        `import { local } from './local.js'`,
        `export const y = thing + readFileSync.name + readFile.name + local`,
      ].join('\n'),
    });
    expect(matches).toEqual([]);
  });

  it('IGNORES import-like text inside a string literal (the AST invariant)', async () => {
    const matches = await phantomMatches({
      path: 'a.ts',
      content: [
        `const snippet = "import express from 'express'"`,
        "const tmpl = `import { z } from 'zod'`",
        `const re = /import .* from 'react'/`,
        `export const all = snippet + tmpl + String(re)`,
      ].join('\n'),
    });
    // express / zod / react appear only inside strings — none are real imports.
    expect(matches).toEqual([]);
  });

  it('detects dynamic import() and require() specifiers', async () => {
    const matches = await phantomMatches({
      path: 'a.ts',
      content: [
        `export async function load() { return import('dyn-undeclared') }`,
        `export const r = require('req-undeclared')`,
      ].join('\n'),
    });
    expect(matches).toContain('dyn-undeclared');
    expect(matches).toContain('req-undeclared');
  });

  it('detects re-export specifiers (export ... from)', async () => {
    const matches = await phantomMatches({
      path: 'a.ts',
      content: `export { foo } from 'reexport-undeclared'`,
    });
    expect(matches).toContain('reexport-undeclared');
  });

  it('flags a devDependency used in non-test code, but allows it in a test file', async () => {
    const matches = await phantomMatches(
      { path: 'a.ts', content: `import { d } from 'dev-only-pkg'\nexport const y = d` },
      { path: 'a.test.ts', content: `import { d } from 'dev-only-pkg'\nexport const y = d` },
    );
    // Exactly the non-test usage is flagged.
    expect(matches.filter((m) => m === 'dev-only-pkg')).toHaveLength(1);
  });

  it('allows a devDependency import from a build/tooling *.config.ts file', async () => {
    const matches = await phantomMatches({
      path: 'vitest.config.ts',
      content: `import { defineConfig } from 'dev-only-pkg'\nexport default defineConfig({})`,
    });
    expect(matches).toEqual([]);
  });

  it('skips workspace packages declared via the workspace: protocol', async () => {
    const run = await runCheckOnFixture(check(), {
      files: [
        {
          path: 'package.json',
          content: JSON.stringify({ name: 'demo', dependencies: { '@scope/ws': 'workspace:*' } }),
        },
        { path: 'a.ts', content: `import { w } from '@scope/ws'\nexport const y = w` },
      ],
    });
    expect(run.findings).toEqual([]);
  });
});
