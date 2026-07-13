import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dogfoodGroundTruth } from './dogfood.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

describe('dogfood ground truth', () => {
  it('pins pnpm, Turbo, and the public build/test commands', () => {
    const manifest = JSON.parse(readRepoFile('package.json')) as {
      packageManager: string;
      scripts: { build: string; test: string };
    };
    const turbo = JSON.parse(readRepoFile('turbo.json')) as {
      tasks: Record<string, unknown>;
    };

    expect(manifest.packageManager).toMatch(/^pnpm@/);
    expect(manifest.scripts.build).toContain('turbo run build');
    expect(manifest.scripts.test).toContain('turbo run test');
    expect(turbo.tasks).toHaveProperty('build');
    expect(turbo.tasks).toHaveProperty('test');
    expect(existsSync(join(repoRoot, dogfoodGroundTruth.lockfile))).toBe(true);
    expect(dogfoodGroundTruth).toMatchObject({
      packageManager: 'pnpm',
      buildSystem: 'turbo',
      buildCommand: 'pnpm build',
      testCommand: 'pnpm test',
    });
  });

  it('pins each anchor definition, public export, and durable references', () => {
    expect(dogfoodGroundTruth.anchors).toHaveLength(2);

    for (const anchor of dogfoodGroundTruth.anchors) {
      const declarationPrefix = anchor.declarationKind === 'class' ? 'class' : 'function';
      expect(readRepoFile(anchor.definingFile)).toContain(
        `export ${declarationPrefix} ${anchor.symbol}`,
      );
      expect(anchor.referenceFiles.length).toBeGreaterThanOrEqual(2);
      expect(anchor.referenceFiles.length).toBeLessThanOrEqual(3);
      for (const referenceFile of anchor.referenceFiles) {
        expect(readRepoFile(referenceFile)).toContain(anchor.symbol);
      }
      if ('publicExportFile' in anchor) {
        expect(readRepoFile(anchor.publicExportFile)).toContain(`export { ${anchor.symbol}`);
      }
    }
  });

  it('pins fixture exclusions across the repository analysis gates', () => {
    const globExclusionFiles = [
      'opensip-cli.config.yml',
      '.config/eslint.config.mjs',
      '.config/knip.json',
      '.prettierignore',
      'scripts/build-test-tsconfigs.mjs',
    ];

    for (const configFile of globExclusionFiles) {
      expect(readRepoFile(configFile)).toContain('**/__fixtures__/**');
    }
    expect(readRepoFile('.config/dependency-cruiser.cjs')).toContain("'/__fixtures__/'");
    expect(
      readRepoFile('packages/graph/engine/src/cli/orchestrate/canonical-file-set.ts'),
    ).toContain("const FIXTURES_SEGMENT = '/__fixtures__/'");
    expect(readRepoFile('packages/clone-detection/src/test-file.ts')).toContain(
      'TEST_FIXTURES_DIR_RE',
    );
  });
});
