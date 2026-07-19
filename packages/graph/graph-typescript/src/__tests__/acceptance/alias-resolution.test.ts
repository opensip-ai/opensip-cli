/**
 * Acceptance fixture: alias resolution.
 *
 * A caller-local alias resolves through the unaliased source name, even when
 * the repo contains a declaration whose real name matches that local alias.
 * Default imports retain their named/anonymous source identities too.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findOccurrence, runFixture, writeFixture } from './_fixture-runner.js';

import type { Catalog } from '@opensip-cli/graph';

describe('alias-resolution acceptance fixture', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-alias-'));
  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  writeFixture(fixtureDir, {
    'source.ts': `export function sourceName(): number { return 42; }\n`,
    'decoy.ts': `export function localAlias(): number { return -1; }\n`,
    'named-default.ts': `export default function sourceDefault(): number { return 7; }\n`,
    'anonymous-default.ts': `export default function(): number { return 8; }\n`,
    'caller.ts': [
      `import { sourceName as localAlias } from './source.js';`,
      `import namedDefault from './named-default.js';`,
      `import anonymousDefault from './anonymous-default.js';`,
      `export function caller(): number {`,
      `  return localAlias() + namedDefault() + anonymousDefault();`,
      `}`,
    ].join('\n'),
  });
  let catalog!: Catalog;
  beforeAll(async () => {
    catalog = await runFixture(fixtureDir);
  });

  it('resolves a named alias to its source declaration, not a local-name decoy', () => {
    const callerOcc = findOccurrence(catalog, (o) => o.simpleName === 'caller');
    expect(callerOcc).toBeDefined();
    expect(callerOcc!.calls.length).toBeGreaterThan(0);
    const aliasEdge = callerOcc!.calls.find((e) => e.text.includes('localAlias'));
    expect(aliasEdge).toBeDefined();
    expect(aliasEdge!.to.length).toBe(1);
    expect(aliasEdge!.resolution).toBe('static');
    expect(aliasEdge!.confidence).toBe('high');

    const sourceOcc = findOccurrence(
      catalog,
      (o) => o.simpleName === 'sourceName' && o.filePath === 'source.ts',
    );
    const decoyOcc = findOccurrence(
      catalog,
      (o) => o.simpleName === 'localAlias' && o.filePath === 'decoy.ts',
    );
    expect(sourceOcc).toBeDefined();
    expect(decoyOcc).toBeDefined();
    expect(aliasEdge!.to[0]).toBe(sourceOcc!.bodyHash);
    expect(aliasEdge!.to[0]).not.toBe(decoyOcc!.bodyHash);
  });

  it.each([
    ['namedDefault', 'sourceDefault', 'named-default.ts'],
    ['anonymousDefault', '<default>', 'anonymous-default.ts'],
  ])('preserves %s default-import resolution', (bindingName, sourceName, filePath) => {
    const callerOcc = findOccurrence(catalog, (o) => o.simpleName === 'caller');
    const edge = callerOcc?.calls.find((candidate) => candidate.text.includes(bindingName));
    const target = findOccurrence(
      catalog,
      (occurrence) => occurrence.simpleName === sourceName && occurrence.filePath === filePath,
    );

    expect(edge).toBeDefined();
    expect(target).toBeDefined();
    expect(edge!.to).toEqual([target!.bodyHash]);
    expect(edge!.resolution).toBe('static');
    expect(edge!.confidence).toBe('high');
  });
});
