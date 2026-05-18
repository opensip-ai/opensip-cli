/**
 * Tool contract conformance test for fitnessTool.
 *
 * Mirrors the graph + simulation tests: catches version-drift between
 * `metadata.version` and package.json. Before tools/lib/package-version
 * existed, both fields were hardcoded literals that drifted silently
 * across releases.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fitnessTool } from '../tool.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(
  readFileSync(resolve(HERE, '../../package.json'), 'utf8'),
) as { version: string };

describe('fitnessTool contract conformance', () => {
  it("metadata.id is 'fitness'", () => {
    expect(fitnessTool.metadata.id).toBe('fitness');
  });

  it('metadata.version matches package.json', () => {
    expect(fitnessTool.metadata.version).toBe(PKG.version);
  });

  it('metadata.description is non-empty', () => {
    expect(fitnessTool.metadata.description.length).toBeGreaterThan(0);
  });

  it('commands list includes fit, dashboard, fit-list, fit-recipes', () => {
    const names = fitnessTool.commands.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['fit', 'dashboard', 'fit-list', 'fit-recipes']),
    );
  });

  it('register is callable', () => {
    expect(typeof fitnessTool.register).toBe('function');
  });
});
