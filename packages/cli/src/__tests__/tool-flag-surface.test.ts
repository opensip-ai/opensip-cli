/**
 * Capability guard (Tier-2): lock the registered flag surface of every
 * first-party tool. A flag added or removed from any command — across all of
 * fit / graph / sim's subcommands — must be a deliberate change to the
 * expected set here, so the CLI's promised surface can't drift undocumented.
 *
 * This is the cross-tool counterpart to the sim-specific capability test; it
 * records flags via a chainable stand-in for commander's `Command`, so it needs
 * no commander dependency and never invokes a command action.
 */

import { describe, expect, it } from 'vitest';

import { FIRST_PARTY_TOOLS } from '../bootstrap/register-tools.js';

import type { Tool, ToolCliContext } from '@opensip-tools/core';

/**
 * Run a tool's `register()` against a recorder that captures every long flag.
 * The recorder answers any method/property with itself (so chained
 * `.command(...).description(...).option(...).action(...)` etc. all work) and
 * records the `--flag` from each `.option(spec)` call.
 */
function recordToolFlags(tool: Tool): string[] {
  const flags = new Set<string>();
   
  // Self-referential proxy: the traps return `recorder`, so it must be declared
  // then assigned (a const cannot reference itself in its own initializer).
  // eslint-disable-next-line prefer-const
  let recorder: any;
  const returnRecorder = (): unknown => recorder;
  const recordOption = (spec: unknown): unknown => {
    const match = /--[a-z][a-z-]*/.exec(String(spec));
    if (match) flags.add(match[0]);
    return recorder;
  };
  const handler: ProxyHandler<() => unknown> = {
    get: (_target, prop) => (prop === 'option' ? recordOption : returnRecorder),
    apply: returnRecorder,
  };
  recorder = new Proxy(function noop() { return recorder; }, handler);
  // cli answers `program` with the recorder; any other method register() calls
  // (registerLiveView, …) is a harmless no-op — we only care about the flags.
  const cli = new Proxy(
    {},
    { get: (_t, prop) => (prop === 'program' ? recorder : () => undefined) },
  ) as unknown as ToolCliContext;
  tool.register(cli);
  return [...flags].sort();
}

// The locked flag surface per tool (union across all of each tool's
// subcommands). Adding/removing a flag is a deliberate edit here.
const EXPECTED: Record<string, string[]> = {
  fitness: [
    '--api-key', '--check', '--config', '--cwd', '--debug', '--exclude',
    '--findings', '--gate-compare', '--gate-save', '--json', '--list', '--open',
    '--quiet', '--recipe', '--recipes', '--report-to', '--tags', '--verbose',
  ],
  graph: [
    // ADR-0011 (Phase 5): graph gained --api-key for --report-to cloud egress.
    '--api-key', '--changed-file', '--concurrency', '--cwd', '--debug',
    '--gate-compare', '--gate-save', '--json', '--language', '--mode',
    '--no-cache', '--out', '--profile', '--recipe', '--report-to', '--resolution',
    '--run-id', '--verbose', '--workspace',
  ],
  // ADR-0011 (Phase 4): sim gained --report-to / --api-key cloud egress.
  simulation: ['--api-key', '--cwd', '--debug', '--json', '--kind', '--open', '--quiet', '--recipe', '--report-to'],
};

describe('first-party tool flag-surface contract', () => {
  for (const tool of FIRST_PARTY_TOOLS) {
    it(`${tool.metadata.id}: registers exactly its documented flag set`, () => {
      const expected = EXPECTED[tool.metadata.id];
      expect(expected, `no expected flag set for tool '${tool.metadata.id}'`).toBeDefined();
      expect(recordToolFlags(tool)).toEqual([...expected].sort());
    });
  }
});
