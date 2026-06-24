import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NEAR_DUP_SIGNATURE_K } from '@opensip-cli/graph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverFiles } from '../discover.js';

import { buildCatalog } from './_pipeline.js';

function allOccurrences(catalog: ReturnType<typeof buildCatalog>['catalog']) {
  return Object.values(catalog.functions).flat();
}

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    strict: true,
    rootDir: '.',
  },
  include: ['**/*.ts'],
});

describe('TypeScript bodySignature population', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-ts-sig-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('populates bodySignature on walked function occurrences', () => {
    writeFileSync(join(dir, 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
    writeFileSync(
      join(dir, 'work.ts'),
      `export function work(items: string[]) {
  const out: string[] = [];
  for (const item of items) out.push(item.trim());
  return out;
}
`,
      'utf8',
    );
    const discovery = discoverFiles({ projectDir: dir });
    const { catalog } = buildCatalog({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      tsConfigPathAbs: discovery.tsConfigPathAbs,
    });
    const withSig = allOccurrences(catalog).filter((o) => o.bodySignature !== undefined);
    expect(withSig.length).toBeGreaterThan(0);
    expect(withSig[0]?.bodySignature?.length).toBe(NEAR_DUP_SIGNATURE_K);
  });
});
