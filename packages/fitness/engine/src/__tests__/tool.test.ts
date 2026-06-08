/* eslint-disable sonarjs/deprecation -- exercises the deprecated-but-supported Tool.register() contract through 2.x (removed in 3.0.0; fit/graph/sim migrate to commandSpecs in release 2.11.0 Phases 3-5). The register() path is sanctioned until then, so these tests must access it. */
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

  it('commands list includes fit, fit-list, fit-recipes', () => {
    const names = fitnessTool.commands.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['fit', 'fit-list', 'fit-recipes']),
    );
  });

  it("no longer owns the cross-tool 'dashboard' command (moved to the CLI in L2)", () => {
    const names = fitnessTool.commands.map((c) => c.name);
    expect(names).not.toContain('dashboard');
  });

  it('contributes dashboard data via the Tool.collectDashboardData seam', () => {
    expect(typeof fitnessTool.collectDashboardData).toBe('function');
  });

  it('register is callable', () => {
    expect(typeof fitnessTool.register).toBe('function');
  });
});
