/**
 * decorate-tool-primary — the host-owned tool-primary decorator. Pure surface
 * decoration over a Commander command (no scope / IO), so it unit-tests directly
 * against a real Commander root.
 */

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { decorateToolPrimary, toolVersionString } from '../decorate-tool-primary.js';

import type { Tool } from '@opensip-cli/core';

/** A minimal Tool stub — only the fields the decorator reads. */
function toolStub(over: Partial<Tool['metadata']> & { contractVersion?: string } = {}): Tool {
  const { contractVersion, ...metaOver } = over;
  const tool: Tool = {
    metadata: {
      id: '00000000-0000-0000-0000-000000000000',
      name: 'demo',
      version: '9.9.9',
      description: 'demo tool',
      ...metaOver,
    },
    ...(contractVersion === undefined ? {} : { contractVersion }),
  };
  return tool;
}

const longFlags = (cmd: Command): string[] =>
  cmd.options.map((o) => o.long).filter((l): l is string => typeof l === 'string');

describe('toolVersionString', () => {
  it('is `<name> <version>` when the tool declares no contractVersion', () => {
    expect(toolVersionString(toolStub({ name: 'fit', version: '0.1.6' }))).toBe('fit 0.1.6');
  });

  it('appends the `(tool contract v<n>)` marker when contractVersion is declared', () => {
    expect(
      toolVersionString(toolStub({ name: 'fit', version: '0.1.6', contractVersion: '1.0' })),
    ).toBe('fit 0.1.6 (tool contract v1.0)');
  });
});

describe('decorateToolPrimary', () => {
  it('adds --version + the full guaranteed baseline to a bare primary', () => {
    const cmd = new Command('demo');
    decorateToolPrimary(cmd, toolStub());
    const flags = longFlags(cmd);
    for (const f of ['--version', '--cwd', '--json', '--config', '--quiet', '--verbose']) {
      expect(flags, `bare primary must gain ${f}`).toContain(f);
    }
    expect(cmd.options.find((o) => o.long === '--version')?.description).toBe(
      "Print this tool's version",
    );
  });

  it('is idempotent: does not double-register flags the tool already declared', () => {
    const cmd = new Command('demo');
    // Simulate a tool that already declared the whole baseline + --config (fit-like).
    cmd
      .option('--cwd <path>', 'Target directory')
      .option('--json', 'Output structured JSON')
      .option('-q, --quiet', 'quiet')
      .option('-v, --verbose', 'verbose')
      .option('--config <path>', 'cfg');
    // Commander throws on a duplicate flag registration; a passing call proves
    // the decorator skipped the already-present ones.
    expect(() => decorateToolPrimary(cmd, toolStub())).not.toThrow();
    // Exactly one of each long flag (no duplicates).
    const counts = new Map<string, number>();
    for (const f of longFlags(cmd)) counts.set(f, (counts.get(f) ?? 0) + 1);
    for (const [flag, n] of counts) expect(n, `${flag} registered exactly once`).toBe(1);
    // --version is the only thing the decorator had to add here.
    expect(counts.get('--version')).toBe(1);
  });

  it('skips --version when the tool somehow already declared it', () => {
    const cmd = new Command('demo').option('--version', 'pre-existing');
    expect(() => decorateToolPrimary(cmd, toolStub())).not.toThrow();
    expect(longFlags(cmd).filter((f) => f === '--version')).toHaveLength(1);
  });
});
