/**
 * Tool contract conformance test (AC-2).
 *
 * Asserts:
 *  - graphTool.metadata.id === 'graph'
 *  - graphTool.metadata.version matches package.json
 *  - graphTool.commands lists graph, graph-orphans, graph-entry-points
 *  - graphTool does NOT import from @opensip-tools/cli (compile-time
 *    via TypeScript imports — if it did, package wouldn't build)
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { graphTool } from '../tool.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('graphTool contract conformance (AC-2)', () => {
  const pkgPath = resolve(HERE, '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

  it("metadata.id is 'graph'", () => {
    expect(graphTool.metadata.id).toBe('graph');
  });

  it('metadata.version matches package.json', () => {
    expect(graphTool.metadata.version).toBe(pkg.version);
  });

  it('commands lists graph, graph-orphans, graph-entry-points', () => {
    const names = graphTool.commands.map((c) => c.name);
    expect(names).toContain('graph');
    expect(names).toContain('graph-orphans');
    expect(names).toContain('graph-entry-points');
  });

  it('register is callable', () => {
    expect(typeof graphTool.register).toBe('function');
  });
});
