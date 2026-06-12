/**
 * scanImports (scan-imports.ts) — the optional method-7 contract
 * (ADR-0045): deterministic sorted (from, to) output; external
 * specifiers dropped; both endpoints inside the candidate file set;
 * require-style imports detected; and structurally NO ts.Program.
 *
 * `compilerOptions` come from the adapter's own `discoverFiles` so the
 * tests exercise the real production input shape.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adapter } from '../index.js';
import { scanImports } from '../scan-imports.js';

import type { DiscoverOutput, ScanImportsInput } from '@opensip-tools/graph';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'nodenext',
    moduleResolution: 'nodenext',
    strict: true,
    rootDir: '.',
  },
  include: ['src/**/*.ts'],
});

describe('scanImports', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-ts-scan-imports-'));
    writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG, 'utf8');
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'src', 'a.ts'),
      "import { b } from './b.js';\nimport { readFileSync } from 'node:fs';\nimport ts from 'typescript';\nexport const a = b;\nvoid readFileSync;\nvoid ts;\n",
      'utf8',
    );
    writeFileSync(
      join(dir, 'src', 'b.ts'),
      "export const b = 1;\nexport * from './c.js';\n",
      'utf8',
    );
    writeFileSync(join(dir, 'src', 'c.ts'), "import { b } from './b.js';\nexport const c = b;\n", 'utf8');
    writeFileSync(join(dir, 'src', 'd.ts'), 'export const d = 4;\n', 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function discover(): DiscoverOutput {
    return adapter.discoverFiles({ cwd: dir });
  }

  function scanInput(discovered: DiscoverOutput): ScanImportsInput {
    return {
      projectDirAbs: discovered.projectDirAbs,
      files: discovered.files,
      configPathAbs: discovered.configPathAbs,
      compilerOptions: discovered.compilerOptions,
    };
  }

  function fileByBasename(discovered: DiscoverOutput, basename: string): string {
    const match = discovered.files.find((f) => f.endsWith(`/${basename}`));
    if (match === undefined) throw new Error(`fixture file ${basename} not discovered`);
    return match;
  }

  it('returns exactly the in-set edges, sorted, with externals dropped', () => {
    const discovered = discover();
    const out = scanImports(scanInput(discovered));
    const a = fileByBasename(discovered, 'a.ts');
    const b = fileByBasename(discovered, 'b.ts');
    const c = fileByBasename(discovered, 'c.ts');
    // node:fs / typescript externals dropped; export-from counts; cycle legal;
    // isolated d.ts appears in no edge.
    expect(out.edges).toEqual([
      [a, b],
      [b, c],
      [c, b],
    ]);
  });

  it('is deterministic and independent of input file order', () => {
    const discovered = discover();
    const first = scanImports(scanInput(discovered));
    const second = scanImports(scanInput(discovered));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const reversed = scanImports({
      ...scanInput(discovered),
      files: [...discovered.files].reverse(),
    });
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(first));
  });

  it('drops edges whose target resolves OUTSIDE input.files', () => {
    const discovered = discover();
    const b = fileByBasename(discovered, 'b.ts');
    const subset = discovered.files.filter((f) => f !== b);
    const out = scanImports({ ...scanInput(discovered), files: subset });
    // a→b, b→c, c→b all touch b.ts — nothing survives.
    expect(out.edges).toEqual([]);
  });

  it('detects require-style imports (detectJavaScriptImports)', () => {
    writeFileSync(
      join(dir, 'src', 'e.ts'),
      "const x = require('./b.js');\nvoid x;\n",
      'utf8',
    );
    const discovered = discover();
    const e = fileByBasename(discovered, 'e.ts');
    const b = fileByBasename(discovered, 'b.ts');
    const out = scanImports(scanInput(discovered));
    expect(out.edges).toContainEqual([e, b]);
  });

  it('never builds a semantic program (structural: no createProgram in the source)', () => {
    const src = readFileSync(fileURLToPath(new URL('../scan-imports.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('createProgram');
  });
});
